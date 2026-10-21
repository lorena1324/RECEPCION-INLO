/* =========================================================
   INLOTRANS
   Motor de muelles 3D para la app actual

   Solo dibuja. Todo lo que es del sistema —qué vehículo hay en
   cada muelle, su meta, los botones de cada rol, la ficha— lo
   decide shared/components/tableroMuelles3D.js con los mismos
   servicios de siempre, y llega aquí ya calculado.

   La ficha del vehículo NO se dibuja aquí: es HTML de la página
   (los mismos botones de cada panel) que entra por el <slot
   name="ficha">. Así los clics siguen llegando a los manejadores
   que cada panel ya tiene en document.body.
   ========================================================= */

import { useEffect, useSyncExternalStore, useState } from "react";
import { IconBox, IconBolt, IconMaximize, IconMinimize, IconRotate360, IconTruckLoading } from "@tabler/icons-react";

import TableroMuelles3D from "../3d/TableroMuelles3D.jsx";
import { usarEscalaPantalla } from "../3d/usarEscalaPantalla.js";
import { AvancePorMuelle, ListaPatio, ResumenMuelles } from "../tablero/Indicadores.jsx";

/* ── CALIDAD DEL 3D ─────────────────────────────────────────
   Los televisores (y los equipos con poco procesador o memoria)
   arrancan en modo ligero sin que nadie tenga que tocar nada: en
   alta se traban. Si alguien elige a mano, se recuerda en ese
   equipo. Y si en alta el 3D va lento, baja solo a ligero. */

const CLAVE_CALIDAD = "inlotrans:calidad3d";

function equipoDebil() {
    const ua = navigator.userAgent || "";
    const esTv = /SmartTV|SMART-TV|Tizen|Web0S|webOS|NetCast|BRAVIA|HbbTV|AFT[A-Z]|CrKey|Android TV|GoogleTV|Roku|Vidaa|Hisense|VIDAA|Philips|Viera|TV Safari/i.test(ua);
    const pocaMemoria = typeof navigator.deviceMemory === "number" && navigator.deviceMemory <= 4;
    const pocosNucleos = typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency <= 4;
    return esTv || pocaMemoria || pocosNucleos;
}

function calidadGuardada() {
    try { return localStorage.getItem(CLAVE_CALIDAD); } catch { return null; }
}

function calidadInicial() {
    const guardada = calidadGuardada();
    if (guardada === "alta" || guardada === "ligera") return guardada;
    return equipoDebil() ? "ligera" : "alta";
}

export default function MotorMuelles({ almacen, acciones }) {

    const e = useSyncExternalStore(almacen.suscribir, almacen.leer);
    const [giro, setGiro] = useState(false);
    const [verCarga, setVerCarga] = useState(false);
    const [calidad, setCalidad] = useState(calidadInicial);

    // Elegida a mano: se recuerda en este equipo.
    const elegirCalidad = () => setCalidad((c) => {
        const nueva = c === "alta" ? "ligera" : "alta";
        try { localStorage.setItem(CLAVE_CALIDAD, nueva); } catch { /* sin almacenamiento: solo por esta vez */ }
        return nueva;
    });

    // Va lento en alta y nadie eligió a mano: baja solo a ligero.
    const degradar = () => { if (!calidadGuardada()) setCalidad("ligera"); };
    // Pantalla completa = televisor visto de lejos: todo se agranda
    // según la altura de la pantalla.
    const escala = usarEscalaPantalla(e.expandido);
    const zoom = escala === 1 ? undefined : { zoom: escala };

    /* Al expandir o encoger, el lienzo cambia de tamaño sin que la
       ventana lo haga. Se avisa con un "resize" para que el canvas
       se mida de nuevo en el acto y no se quede con el tamaño viejo
       (una franja vacía abajo). */
    useEffect(() => {
        const avisar = () => window.dispatchEvent(new Event("resize"));
        const cuadro = requestAnimationFrame(avisar);
        const tarde = setTimeout(avisar, 350);
        return () => { cancelAnimationFrame(cuadro); clearTimeout(tarde); };
    }, [e.expandido]);

    return (
        <div className="flex h-full flex-col overflow-hidden bg-panel text-texto">

            <header className="flex items-center gap-2 border-b border-borde px-3 py-2">
                <IconTruckLoading size={18} className="text-marca" />
                <span className="truncate text-sm font-semibold">
                    {e.expandido ? e.titulo : "Vista 3D"}
                </span>

                <div className="ml-auto flex items-center gap-1">
                    <Interruptor icono={IconBox} activo={verCarga} onClick={() => setVerCarga((v) => !v)} etiqueta="Ver carga" />
                    <Interruptor icono={IconRotate360} activo={giro} onClick={() => setGiro((g) => !g)} etiqueta="Giro" />
                    <Interruptor icono={IconBolt} activo={calidad === "ligera"} onClick={elegirCalidad} etiqueta="Modo ligero" />
                    <button
                        onClick={() => acciones.onExpandir(!e.expandido)}
                        className="rounded-lg p-1.5 text-texto-suave hover:bg-fondo hover:text-texto"
                        title={e.expandido ? "Salir de pantalla completa (Esc)" : "Pantalla completa"}
                        aria-label={e.expandido ? "Salir de pantalla completa" : "Pantalla completa"}
                    >
                        {e.expandido ? <IconMinimize size={18} /> : <IconMaximize size={18} />}
                    </button>
                </div>
            </header>

            <div className="relative flex-1">
                <TableroMuelles3D
                    muelles={e.muelles}
                    patio={e.patio}
                    salientes={e.salientes}
                    nombreBodega={e.nombreBodega}
                    seleccionado={e.seleccionado}
                    seleccionadoPatio={e.seleccionadoPatio}
                    onSeleccionar={acciones.onSeleccionar}
                    onSeleccionarPatio={acciones.onSeleccionarPatio}
                    onSalio={acciones.onSalio}
                    animarLlegada={e.animarLlegada}
                    giroAutomatico={giro}
                    verCargaTodos={verCarga}
                    calidad={calidad}
                    onLento={degradar}
                    compacta={!e.expandido}
                    escala={escala}
                    semaforo={e.semaforo}
                    pausado={e.pausado}
                />

                {/* Columna izquierda: el resumen (expandido) y la fila
                    del patio, que reemplaza a la tabla de patio de la
                    página para que todo quede en un solo sitio. */}
                <div style={zoom} className="pointer-events-none absolute bottom-3 left-3 top-3 z-20 flex flex-col items-start gap-2 [&>*]:pointer-events-auto">
                    {e.expandido && <ResumenMuelles muelles={e.muelles} enPatio={e.patio.length} />}
                    <ListaPatio
                        patio={e.patio}
                        seleccionado={e.seleccionadoPatio}
                        onSeleccionar={acciones.onSeleccionarPatio}
                        colorNivel={(nivel) => e.semaforo?.[nivel] ?? "#7d8794"}
                    />
                </div>

                {e.expandido && (
                    <div style={zoom} className={`absolute top-3 z-20 ${e.hayFicha ? "right-[360px]" : "right-3"}`}>
                        <AvancePorMuelle muelles={e.muelles} onSeleccionar={acciones.onSeleccionar} />
                    </div>
                )}

                {/* La ficha del vehículo: HTML de la página */}
                <div style={zoom} className="pointer-events-none absolute bottom-3 right-3 top-3 z-30 flex flex-col items-end">
                    <slot name="ficha" />
                </div>
            </div>
        </div>
    );
}

function Interruptor({ icono: Icono, activo, onClick, etiqueta }) {
    return (
        <button
            onClick={onClick}
            aria-pressed={activo}
            title={etiqueta}
            className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium ${activo ? "border-marca bg-marca/15 text-texto" : "border-transparent text-texto-suave hover:bg-fondo"}`}
        >
            <Icono size={15} />
            <span className="hidden xl:inline">{etiqueta}</span>
        </button>
    );
}
