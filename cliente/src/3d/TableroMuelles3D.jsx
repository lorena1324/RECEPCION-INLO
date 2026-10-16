/* =========================================================
   INLOTRANS
   Tablero de muelles en 3D

   Recibe los muelles con su Vehiculo (o null si está libre) y
   los vehículos que van saliendo, y dibuja cada uno con la
   carrocería de su tipología, y la fila del patio con los que
   esperan muelle. Todo lo que el usuario puede HACER vive fuera
   del canvas (la ficha la pone la página): aquí solo se muestra
   y se selecciona.

   Iluminación y reflejos son locales (Lightformers), sin HDRI
   descargado, para que cargue igual en las redes de las
   bodegas. `calidad="ligera"` apaga el posprocesado para los
   equipos sin tarjeta de video.
   ========================================================= */

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Html, Lightformer, OrbitControls } from "@react-three/drei";
import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { animate } from "motion";

import { crearModelo } from "./vehiculos/index.js";
import { usarOrbitaConInercia } from "./usarOrbitaConInercia.js";
import Bodega from "./escenario/Bodega.jsx";
import {
    LARGO_CUPO, MUELLE, SEPARACION_PATIO, Z_CARRIL, Z_FICHA, Z_MUELLE, Z_PATIO,
    anchoBodega, cuposPatio, xDeCupo, xDeMuelle, xEntrada, xSalida
} from "./escenario/medidas.js";

// Validados contra el fondo oscuro del tablero (skill dataviz):
// pasan separación para daltonismo y contraste 3:1.
export const COLOR_FASE = {
    Descargue: "#d95926",
    Cargue: "#3987e5"
};

export const COLOR_NIVEL = {
    ok: "#0ca30c",
    atencion: "#fab219",
    urgente: "#d03b3b"
};

// Un registro viejo puede traer una fase que no es ninguna de las
// dos (p. ej. "Ambos" sin fase elegida): se pinta neutro.
export function colorFase(fase) {
    return COLOR_FASE[fase] ?? "#7d8794";
}

/*
    Color y aviso de la tarjeta de un muelle.

    Sin `semaforo` (laboratorio) la tarjeta va del color de la fase.
    Con `semaforo` (la app real) va del color del semáforo de tiempo,
    que es lo que dice la leyenda de los paneles: Libre, En meta,
    Atención, Pasado de meta. Los colores los pone el panel, leídos
    de su propio CSS, así que siguen el tema claro/oscuro.
*/
function estadoMuelle(muelle, semaforo) {

    const v = muelle.vehiculo;
    if (!v) return { color: semaforo ? semaforo.libre : "#2d3a4f", aviso: null };

    const nivel = v.nivelTiempo(muelle.minutos ?? 0);

    if (semaforo) {
        return {
            color: semaforo[nivel] ?? semaforo.ok,
            aviso: nivel === "urgente" ? "Pasado de meta" : nivel === "atencion" ? "Atención" : null,
            colorAviso: semaforo[nivel]
        };
    }

    return {
        color: colorFase(v.fase),
        aviso: nivel === "urgente" ? "Dobló la meta" : nivel === "atencion" ? "Pasó la meta" : null,
        colorAviso: COLOR_NIVEL[nivel]
    };
}

/*
    Color del reloj "sin cabezote": el mismo semáforo del resto del
    tablero. El motor recibe el nivel como lo calcula la página
    ('normal' | 'media' | 'alta') y el semáforo habla en ok / atención
    / urgente.
*/
const NIVEL_SIN_CABEZOTE = { normal: "ok", media: "atencion", alta: "urgente" };

function colorSinCabezote(v, semaforo) {
    const n = NIVEL_SIN_CABEZOTE[v.nivelSinCabezote] ?? "ok";
    return (semaforo ? semaforo[n] : COLOR_NIVEL[n]) ?? "#7d8794";
}

/*
    LEGIBILIDAD DE LAS TARJETAS

    Los colores del semáforo (verde, ámbar, rojo) son para PINTAR, no
    para escribir encima: un rojo sobre el azul casi negro de la
    tarjeta apenas se lee, y menos desde lejos o en un televisor.
    Por eso el texto es SIEMPRE claro y sobre fondo oscuro, y el color
    del estado va de acento: borde y puntito, con un tinte suave de
    fondo. Así el estado se ve de un vistazo sin sacrificar la lectura.
*/
const TEXTO = "#f8fafc";          // lo principal
const TEXTO_SUAVE = "#d5dde8";    // lo secundario (todavía con buen contraste)
const AMBAR = "#fbbf24";          // "falta un dato"

// El registro dice "Sin tipología" cuando no se ha asignado ninguna.
function sinTipologia(v) {
    return !v.tipologia?.nombre || v.tipologia.nombre === "Sin tipología";
}

function Chip({ color, children, className = "" }) {
    return (
        <div
            className={`flex items-start gap-1.5 rounded-md border px-2 py-1 font-semibold leading-snug ${className}`}
            style={{ color: TEXTO, borderColor: color, background: `color-mix(in srgb, ${color} 24%, #0d131c)` }}
        >
            <span aria-hidden className="mt-[5px] inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
            <span>{children}</span>
        </div>
    );
}
/*
    Cupo de cada vehículo del patio. ESTABLE: el que ya tiene cupo lo
    conserva mientras siga en el patio, y el que llega toma el primero
    libre. Si el cupo saliera del puesto en la fila, cada vez que la
    prioridad se reordena los camiones se pondrían a cambiar de sitio.
    Los que no caben (más cola que cupos pintados) quedan sin cupo:
    salen en la lista lateral pero no en la escena.
*/
function asignarCupos(cupos, patio, disponibles) {

    const presentes = new Set(patio.map((p) => p.vehiculo.id));
    for (const id of [...cupos.keys()]) if (!presentes.has(id)) cupos.delete(id);

    // Se llenan del centro hacia afuera: la fila queda frente a los
    // muelles y no arrinconada en un extremo del patio.
    const centro = (disponibles - 1) / 2;
    const orden = Array.from({ length: disponibles }, (_, i) => i)
        .sort((a, b) => Math.abs(a - centro) - Math.abs(b - centro) || a - b);

    const ocupados = new Set(cupos.values());
    for (const p of patio) {
        if (cupos.has(p.vehiculo.id)) continue;
        const libre = orden.find((i) => !ocupados.has(i));
        if (libre !== undefined) {
            cupos.set(p.vehiculo.id, libre);
            ocupados.add(libre);
        }
    }

    return patio.map((p) => ({ ...p, cupo: cupos.get(p.vehiculo.id) ?? null }));
}

function semillaDe(id) {
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) | 0;
    return Math.abs(h);
}


/* ---------------------------------------------------------
   VEHÍCULO
   --------------------------------------------------------- */

/*
    Un vehículo de la escena, esté en un muelle o en un cupo del
    patio. `destino` es dónde debe quedar ({ x, z }); cuando cambia,
    el vehículo va hasta allá por el carril de maniobra:

        llega      entra por la derecha, avanza por el carril y se
                   mete (en reversa al muelle, de frente al cupo)
        se mueve   sale al carril, lo recorre y se vuelve a meter
        sale       sale al carril y se va por la izquierda

    Los que ya estaban al abrir la página (`animarLlegada` false)
    aparecen directamente en su sitio: si no, el tablero arrancaría
    con un desfile de camiones cada vez que alguien recarga.
*/
function VehiculoEnEscena({ vehiculo, destino, saliendo, animarLlegada, total, verInterior, etiqueta, compacta, escala, onSalio, onSeleccionar }) {

    /*
        Misma tipología → mismos colores (la semilla sale de ella, no
        del vehículo) y su nombre pintado en los costados. Quien aún
        no tiene tipología conserva colores propios y sin rótulo.
    */
    const nombreTipologia = vehiculo.tipologia?.nombre;
    // Dejó el contenedor y se llevó el cabezote: se dibuja solo el contenedor.
    const sinCabezote = !!vehiculo.sinCabezote;
    const conTipologia = !!nombreTipologia && nombreTipologia !== "Sin tipología";
    const semilla = semillaDe(conTipologia ? (vehiculo.tipologia.id ?? nombreTipologia) : vehiculo.id);

    /*
        Cuando llega la tipología el vehículo cambia de carrocería y el
        modelo se vuelve a construir. El nuevo debe nacer donde estaba
        el anterior: si naciera en el origen (0, 0), todos los que
        cambian de tipología quedarían amontonados contra el muro, y
        como su destino no cambió, nadie los volvería a mover.
    */
    const anterior = useRef(null);
    const modelo = useMemo(() => {
        const nuevo = crearModelo(vehiculo.modelo3d, {
            semilla, rotulo: conTipologia ? nombreTipologia : "", sinCabezote: sinCabezote
        });
        if (anterior.current) {
            nuevo.position.copy(anterior.current.position);
            nuevo.rotation.y = anterior.current.rotation.y;
        }
        return nuevo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vehiculo.modelo3d, vehiculo.id, semilla, sinCabezote, conTipologia ? nombreTipologia : ""]);
    const destinoActual = useRef(null);

    // Para saber, en el efecto de abajo, si el modelo cambió desde la
    // vez anterior.
    const modeloVisto = useRef(null);

    useEffect(() => () => modelo.dispose(), [modelo]);

    useEffect(() => {

        const cambioModelo = modeloVisto.current !== null && modeloVisto.current !== modelo;
        modeloVisto.current = modelo;
        anterior.current = modelo;

        if (saliendo) {
            // Nunca llegó a dibujarse (p. ej. estaba en la cola del
            // patio sin cupo): no hay nada que ver salir.
            if (!destinoActual.current) { onSalio(vehiculo.id); return; }
            destinoActual.current = null;
            modelo.recorrer([[modelo.position.x, Z_CARRIL], [xSalida(total), Z_CARRIL]])
                .then((completo) => completo && onSalio(vehiculo.id));
            return;
        }

        if (!destino) return;

        const previo = destinoActual.current;
        destinoActual.current = destino;

        if (!previo) {
            if (!animarLlegada) {
                modelo.colocar(destino.x, destino.z);
                return;
            }
            modelo.colocar(xEntrada(total), Z_CARRIL, -Math.PI / 2);
            modelo.recorrer([[destino.x, Z_CARRIL], [destino.x, destino.z]]);
            return;
        }

        // Modelo nuevo (cambió la tipología) que heredó la pose del anterior:
        // si ya está en su sitio no hay nada que hacer; si lo cambiaron a
        // mitad de camino, sigue desde donde iba.
        if (cambioModelo) {
            if (Math.hypot(modelo.position.x - destino.x, modelo.position.z - destino.z) < 0.05) return;
        } else if (previo.x === destino.x && previo.z === destino.z) return;

        modelo.recorrer([[modelo.position.x, Z_CARRIL], [destino.x, Z_CARRIL], [destino.x, destino.z]]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [modelo, destino?.x, destino?.z, saliendo]);

    useEffect(() => { modelo.mostrarOcupacion(vehiculo.ocupacion); }, [modelo, vehiculo.ocupacion]);
    useEffect(() => { modelo.mostrarAvance(vehiculo.porcentaje, colorFase(vehiculo.fase)); }, [modelo, vehiculo.porcentaje, vehiculo.fase]);
    useEffect(() => { modelo.verInterior(verInterior); }, [modelo, verInterior]);

    useFrame(() => modelo.tick());

    const { alturaPiso, carga } = modelo.esp;

    return (
        <primitive
            object={modelo}
            onClick={(e) => { e.stopPropagation(); onSeleccionar(); }}
            onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = "pointer"; }}
            onPointerOut={() => { document.body.style.cursor = ""; }}
        >
            {/* Los del patio llevan su puesto en la fila y su espera */}
            {etiqueta && !saliendo && (
                <CuandoConectado>
                    <Html position={[0, alturaPiso + carga.alto + 0.9, carga.largo / 2]} center distanceFactor={(compacta ? 30 : 22) * escala} zIndexRange={[8, 0]}>
                        <button
                            onClick={onSeleccionar}
                            className="select-none whitespace-nowrap rounded-lg border-2 bg-[#0d131c]/95 px-2.5 py-1 text-[14px] font-extrabold shadow-lg"
                            style={{ borderColor: etiqueta.color, color: TEXTO }}
                        >
                            #{etiqueta.puesto} · {etiqueta.texto}
                        </button>
                    </Html>
                </CuandoConectado>
            )}
        </primitive>
    );
}


/* ---------------------------------------------------------
   TARJETA SOBRE CADA MUELLE
   --------------------------------------------------------- */

function TarjetaMuelle({ muelle, x, seleccionado, compacta, escala, semaforo, onSeleccionar }) {

    const v = muelle.vehiculo;
    const { color: borde, aviso, colorAviso } = estadoMuelle(muelle, semaforo);
    const opacidad = v?.cancelado ? 0.55 : 1;

    // Embebida: solo número, % y barra, para que las tarjetas de
    // muelles vecinos no se monten unas sobre otras.
    if (compacta) {
        return (
            <Html position={[x, MUELLE.alturaAnden + MUELLE.altoPuerta + 1.2, 0.4]} center distanceFactor={30} zIndexRange={[9, 0]}>
                <button
                    onClick={onSeleccionar}
                    className="w-24 select-none rounded-lg border-2 bg-[#0d131c]/90 px-2 py-1 text-left text-white shadow-lg transition-transform hover:scale-110"
                    style={{ borderColor: borde, opacity: opacidad, transform: seleccionado ? "scale(1.15)" : undefined }}
                >
                    <div className="flex items-baseline justify-between text-xs">
                        <span className="text-sm font-extrabold">M{muelle.numero}</span>
                        <span className="font-bold">{v ? `${v.porcentaje}%` : "Libre"}</span>
                    </div>
                    {v && (
                        <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-[#263244]">
                            <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${v.porcentaje}%`, background: colorFase(v.fase) }} />
                        </div>
                    )}
                </button>
            </Html>
        );
    }

    return (
        <Html
            position={[x, MUELLE.alturaAnden + MUELLE.altoPuerta + 1.55, 0.4]}
            center
            distanceFactor={20 * escala}
            zIndexRange={[9, 0]}
        >
            <button
                onClick={onSeleccionar}
                className="w-48 select-none rounded-xl border-2 bg-[#0d131c]/95 px-3.5 py-2.5 text-left text-white shadow-[0_8px_24px_rgba(0,0,0,0.45)] backdrop-blur-sm transition-transform hover:scale-105"
                style={{ borderColor: borde, opacity: opacidad, transform: seleccionado ? "scale(1.12)" : undefined, boxShadow: seleccionado ? `0 0 0 3px ${borde}55, 0 8px 24px rgba(0,0,0,.45)` : undefined }}
            >
                <div className="flex items-baseline justify-between">
                    <span className="text-2xl font-extrabold leading-none">M{muelle.numero}</span>
                    <span className="text-[14px] font-bold" style={{ color: TEXTO_SUAVE }}>
                        {v ? v.placa : "Disponible"}
                    </span>
                </div>

                {v && (
                    <>
                        <div className="mt-1.5 flex items-baseline justify-between text-[14px] font-semibold">
                            <span>{v.fase}</span>
                            <span className="text-base font-extrabold">{v.porcentaje}%</span>
                        </div>
                        <div className="mt-1 h-2 overflow-hidden rounded-full bg-[#2b394f]">
                            <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${v.porcentaje}%`, background: colorFase(v.fase) }} />
                        </div>
                        {aviso && (
                            <Chip color={colorAviso ?? borde} className="mt-2 text-[13px]">{aviso}</Chip>
                        )}
                        {v.sinCabezote && (
                            <Chip color={colorSinCabezote(v, semaforo)} className="mt-2 text-[13px]">Sin cabezote · {v.minutosSinCabezote} min</Chip>
                        )}
                    </>
                )}
            </button>
        </Html>
    );
}


/* ---------------------------------------------------------
   FICHA EN EL PISO, FRENTE AL VEHÍCULO
   --------------------------------------------------------- */

/*
    La franja de la bahía que queda libre entre el frente del vehículo
    y la línea de pare: placa, fase, tipología, avance y tiempo.
*/
function FichaFrente({ muelle, x, compacta, escala, semaforo, onSeleccionar }) {

    const v = muelle.vehiculo;
    if (!v) return null;

    const { color } = estadoMuelle(muelle, semaforo);

    return (
        <Html position={[x, 0.05, Z_FICHA]} center distanceFactor={(compacta ? 30 : 20) * escala} zIndexRange={[7, 0]}>
            <button
                onClick={onSeleccionar}
                className={`select-none rounded-lg border-l-[6px] bg-[#0d131c]/95 text-left leading-tight shadow-lg ${compacta ? "w-28 px-2 py-1.5" : "w-[196px] px-3 py-2.5"}`}
                style={{ borderColor: color, color: TEXTO, opacity: v.cancelado ? 0.55 : 1 }}
            >
                <div className="flex items-baseline justify-between gap-2">
                    <span className={`font-extrabold tracking-wide ${compacta ? "text-[14px]" : "text-[19px]"}`}>{v.placa}</span>
                    <span className={`rounded px-1.5 font-extrabold ${compacta ? "text-[10px]" : "text-[12px]"}`} style={{ background: "#2b394f", color: TEXTO }}>M{muelle.numero}</span>
                </div>

                {!compacta && v.conductor && <div className="mt-1 truncate text-[12px] font-semibold uppercase" style={{ color: TEXTO_SUAVE }}>{v.conductor}</div>}
                {!compacta && (
                    sinTipologia(v)
                        ? <Chip color={AMBAR} className="mt-1.5 text-[12px]">{v.textoTipologia || "Sin tipología"}</Chip>
                        : <div className="mt-0.5 truncate text-[12px]" style={{ color: TEXTO_SUAVE }}>{v.textoTipologia || v.tipologia.nombre}</div>
                )}

                <div className={`flex items-baseline justify-between ${compacta ? "mt-1 text-[10px]" : "mt-1.5 text-[13px]"} font-semibold`}>
                    <span>{v.fase}</span>
                    <span className={`font-extrabold ${compacta ? "" : "text-[15px]"}`}>{v.porcentaje}%</span>
                </div>
                <div className={`overflow-hidden rounded-full bg-[#2b394f] ${compacta ? "mt-0.5 h-1" : "mt-1 h-2"}`}>
                    <div className="h-full rounded-full" style={{ width: `${v.porcentaje}%`, background: colorFase(v.fase) }} />
                </div>

                {!compacta && v.meta && (
                    <Chip color={v.sinMeta ? AMBAR : color} className="mt-1.5 text-[12px]">{v.meta}</Chip>
                )}

                {v.sinCabezote && (
                    compacta
                        ? <div className="mt-1 text-[10px] font-bold" style={{ color: TEXTO }}>Sin cabezote {v.minutosSinCabezote} min</div>
                        : <Chip color={colorSinCabezote(v, semaforo)} className="mt-1.5 text-[12px]">Sin cabezote · {v.textoSinCabezote}</Chip>
                )}
            </button>
        </Html>
    );
}


/*
    Las tarjetas (<Html> de drei) se montan solo cuando el lienzo ya
    conectó sus eventos. Si se montan antes, drei las cuelga de un
    nodo y al conectarse las muda a otro reutilizando una raíz de
    React que ya desmontó: la primera tarjeta (M1) quedaba vacía y
    no aparecía nunca.
*/
function CuandoConectado({ children }) {
    const conectado = useThree((s) => s.events.connected);
    return conectado ? children : null;
}


/* ---------------------------------------------------------
   MARCA DE SELECCIÓN EN EL PISO
   --------------------------------------------------------- */

function MarcaSeleccion({ x, z = 9, ancho = MUELLE.separacion - 0.6, largo = 18 }) {

    const material = useRef();

    useEffect(() => {
        const c = animate(material.current, { opacity: [0.12, 0.38] }, { duration: 1.1, repeat: Infinity, repeatType: "reverse", ease: "easeInOut" });
        return () => c.stop();
    }, []);

    return (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.02, z]}>
            <planeGeometry args={[ancho, largo]} />
            <meshBasicMaterial ref={material} color="#3987e5" transparent opacity={0.2} depthWrite={false} />
        </mesh>
    );
}


/* ---------------------------------------------------------
   CÁMARA
   --------------------------------------------------------- */

function Camara({ vista, giroAutomatico }) {

    const camara = useThree((s) => s.camera);
    const controles = useThree((s) => s.controls);
    const [volando, setVolando] = useState(false);
    const primeraVez = useRef(true);

    usarOrbitaConInercia({ activo: giroAutomatico, pausado: volando });

    useEffect(() => {

        if (!controles) return;

        if (primeraVez.current) {
            primeraVez.current = false;
            camara.position.set(...vista.camara);
            controles.target.set(...vista.objetivo);
            controles.update();
            return;
        }

        const transicion = { duration: 1.4, ease: [0.16, 1, 0.3, 1] };
        const [cx, cy, cz] = vista.camara;
        const [ox, oy, oz] = vista.objetivo;

        setVolando(true);
        const a = animate(camara.position, { x: cx, y: cy, z: cz }, transicion);
        const b = animate(controles.target, { x: ox, y: oy, z: oz }, transicion);
        Promise.all([a.finished, b.finished]).then(() => setVolando(false));

        return () => { a.stop(); b.stop(); };

    }, [vista, controles, camara]);

    return (
        <OrbitControls
            makeDefault
            enableDamping={false}
            maxPolarAngle={Math.PI / 2.25}
            minDistance={10}
            maxDistance={110}
        />
    );
}


/* ---------------------------------------------------------
   ESCENA
   --------------------------------------------------------- */

export default function TableroMuelles3D({
    muelles,
    patio = [],             // [{ vehiculo, cupo, puesto, minutos, nivel }] ya en orden de prioridad
    salientes = [],
    nombreBodega,
    seleccionado,           // número del muelle elegido
    seleccionadoPatio = null, // id del vehículo de patio elegido
    onSeleccionar,
    onSeleccionarPatio = () => {},
    onSalio,
    animarLlegada = true,
    giroAutomatico = false,
    verCargaTodos = false,
    semaforo = null,
    pausado = false,
    calidad = "alta",
    compacta = false,
    escala = 1              // agrandado en pantalla completa (televisor visto de lejos)
}) {

    const total = muelles.length;
    const ancho = anchoBodega(total);
    const alta = calidad === "alta";

    const cupos = useRef(new Map());
    const patioConCupo = useMemo(() => asignarCupos(cupos.current, patio, cuposPatio(total)), [patio, total]);

    const indice = muelles.findIndex((m) => m.numero === seleccionado);
    const elegidoPatio = patioConCupo.find((p) => p.vehiculo.id === seleccionadoPatio && p.cupo !== null);
    const xPatio = elegidoPatio ? xDeCupo(elegidoPatio.cupo, total) : null;

    // Vista general: muelles adelante y la fila del patio detrás,
    // todo en un solo cuadro.
    const vista = useMemo(() => {
        if (indice >= 0) {
            const x = xDeMuelle(indice, total);
            return { camara: [x + 12, 10, 27], objetivo: [x, 2.2, 7] };
        }
        if (xPatio !== null) {
            return { camara: [xPatio + 10, 13, Z_PATIO + 34], objetivo: [xPatio, 2, Z_PATIO + 6] };
        }
        return { camara: [ancho * 0.24, 40, 76], objetivo: [0, 0, 21] };
    }, [indice, xPatio, total, ancho]);

    const colorNivel = (nivel) => (semaforo ? semaforo[nivel] : COLOR_NIVEL[nivel]) ?? "#7d8794";

    // Vehículos a dibujar: en muelle, en un cupo del patio, y los que
    // se están yendo (siguen en pantalla hasta salir de cuadro). Los
    // del patio sin cupo (la cola es más larga que la fila pintada)
    // solo están en la lista lateral.
    const enEscena = [
        ...muelles.flatMap((m, i) => m.vehiculo
            ? [{ vehiculo: m.vehiculo, destino: { x: xDeMuelle(i, total), z: Z_MUELLE }, numero: m.numero }]
            : []),
        ...patioConCupo.flatMap((p) => p.cupo === null ? [] : [{
            vehiculo: p.vehiculo,
            destino: { x: xDeCupo(p.cupo, total), z: Z_PATIO },
            etiqueta: { puesto: p.puesto, texto: p.textoEspera, color: colorNivel(p.nivel) }
        }]),
        ...salientes.map((s) => ({ vehiculo: s.vehiculo, destino: null, saliendo: true }))
    ];

    return (
        <Canvas
            // Sin cuadros mientras el tablero no está a la vista.
            frameloop={pausado ? "never" : "always"}
            shadows={alta ? "soft" : true}
            dpr={alta ? [1, 2] : 1}
            camera={{ position: vista.camara, fov: 34, near: 0.5, far: 400 }}
            // Solo un clic en el lienzo vacío deselecciona. Las
            // tarjetas de los muelles (Html) están dentro del mismo
            // contenedor, y su clic también llega aquí como "no le
            // dio a nada": sin este filtro, elegir un muelle desde
            // su tarjeta lo deseleccionaba en el acto.
            onPointerMissed={(e) => { if (e.target?.tagName === "CANVAS") onSeleccionar(null); }}
            resize={{ scroll: false, debounce: 0 }}
            gl={{ antialias: !alta, powerPreference: "high-performance" }}
        >
            <color attach="background" args={["#a9b6c5"]} />
            <fog attach="fog" args={["#a9b6c5", 90, 190]} />

            <hemisphereLight args={["#e9f1ff", "#5d6570", 0.55]} />
            <directionalLight
                position={[-30, 42, 34]}
                intensity={2.6}
                color="#fff4e2"
                castShadow
                shadow-mapSize={alta ? [4096, 4096] : [1024, 1024]}
                shadow-bias={-0.0004}
                shadow-normalBias={0.03}
                shadow-camera-left={-80}
                shadow-camera-right={80}
                shadow-camera-top={80}
                shadow-camera-bottom={-80}
                shadow-camera-far={220}
            />

            {/* Reflejos de estudio generados aquí mismo, sin descargar HDRI */}
            <Environment resolution={256} frames={1}>
                <Lightformer form="rect" intensity={2.2} color="#dfe9ff" position={[0, 12, 0]} rotation-x={Math.PI / 2} scale={[40, 40, 1]} />
                <Lightformer form="rect" intensity={1.2} color="#ffffff" position={[-14, 4, 10]} rotation-y={Math.PI / 2} scale={[20, 4, 1]} />
                <Lightformer form="rect" intensity={0.8} color="#ffe8cc" position={[14, 3, -6]} rotation-y={-Math.PI / 2} scale={[20, 3, 1]} />
            </Environment>

            <Bodega
                muelles={muelles}
                nombre={nombreBodega}
                seleccionado={seleccionado}
                colorDe={(m) => (m.vehiculo ? estadoMuelle(m, semaforo).color : semaforo?.libre ?? "#0ca30c")}
            />

            {enEscena.map(({ vehiculo, destino, numero, saliendo, etiqueta }) => (
                <VehiculoEnEscena
                    key={vehiculo.id}
                    vehiculo={vehiculo}
                    destino={destino}
                    saliendo={!!saliendo}
                    animarLlegada={animarLlegada}
                    total={total}
                    etiqueta={etiqueta}
                    compacta={compacta}
                    escala={escala}
                    verInterior={verCargaTodos || (numero != null && numero === seleccionado)}
                    onSalio={onSalio}
                    onSeleccionar={() => {
                        if (numero != null) onSeleccionar(numero);
                        else if (!saliendo) onSeleccionarPatio(vehiculo.id);
                    }}
                />
            ))}

            <CuandoConectado>
                {muelles.map((m, i) => (
                    <TarjetaMuelle
                        key={m.numero}
                        muelle={m}
                        x={xDeMuelle(i, total)}
                        seleccionado={m.numero === seleccionado}
                        compacta={compacta}
                        escala={escala}
                        semaforo={semaforo}
                        onSeleccionar={() => onSeleccionar(m.numero)}
                    />
                ))}
                {muelles.map((m, i) => (
                    <FichaFrente
                        key={m.numero}
                        muelle={m}
                        x={xDeMuelle(i, total)}
                        compacta={compacta}
                        escala={escala}
                        semaforo={semaforo}
                        onSeleccionar={() => onSeleccionar(m.numero)}
                    />
                ))}
            </CuandoConectado>

            {indice >= 0 && <MarcaSeleccion x={xDeMuelle(indice, total)} />}
            {xPatio !== null && (
                <MarcaSeleccion x={xPatio} z={Z_PATIO + LARGO_CUPO / 2} ancho={SEPARACION_PATIO - 0.4} largo={LARGO_CUPO} />
            )}

            <Camara vista={vista} giroAutomatico={giroAutomatico} />

            {alta && (
                <EffectComposer multisampling={0}>
                    <N8AO aoRadius={1.6} intensity={2.4} distanceFalloff={0.8} halfRes />
                    <Bloom luminanceThreshold={1.1} intensity={0.55} mipmapBlur />
                    <ToneMapping mode={ToneMappingMode.AGX} />
                    <SMAA />
                </EffectComposer>
            )}
        </Canvas>
    );
}
