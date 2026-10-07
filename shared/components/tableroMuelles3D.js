/* =========================================================
   INLOTRANS — Tablero de muelles en 3D

   Reemplazo directo de crearTableroMuelles() (tableroMuelles.js):
   MISMA firma, MISMAS opciones, MISMO objeto de vuelta
   (actualizar / rotuloConductor / destruir). Un panel pasa al 3D
   cambiando solo su import:

       import { crearTableroMuelles3D as crearTableroMuelles }
           from "../../../shared/components/tableroMuelles3D.js";

   ── QUÉ HACE AQUÍ Y QUÉ HACE EL MOTOR ──

   Aquí: todo lo del sistema, con los mismos servicios que usa el
   tablero de siempre — qué vehículo hay en cada muelle, su tiempo
   contra la meta, el semáforo, y la FICHA del vehículo elegido con
   los botones y controles que pone cada panel (`acciones`,
   `extras`). La ficha es HTML normal de la página, así que los
   clics llegan a los manejadores que cada panel ya tiene en
   document.body: Mover, Salida, Observación, Novedades, el avance
   y la modalidad del supervisor funcionan sin tocar una línea.

   En el motor (shared/vendor/muelles3d, compilado desde cliente/):
   solo el dibujo. Vive en un Shadow DOM para que sus estilos y los
   de la página no se mezclen.

   ── SI NO SE PUEDE, EL DE SIEMPRE ──

   Sin WebGL (equipos muy viejos, aceleración apagada) o si el
   motor no carga, se monta el tablero de tarjetas de siempre con
   las mismas opciones y los últimos datos. Nadie se queda sin
   tablero.
   ========================================================= */

import { crearTableroMuelles } from "./tableroMuelles.js";

import { minutosEnMuelle, nivelContraMeta, faseActual, prioridadDe } from "../services/eventos.js";
import { tiemposDe, modalidadDe, distingueModalidad, etiquetaCampo, buscarTipologia } from "../services/config.js";
import { requiereAvanceCompleto, estaCancelado } from "../services/vehiculos.js";
import { formatDuration } from "../utils/tiempos.js";


/* =========================================================
   CARROCERÍA 3D DE CADA TIPOLOGÍA

   Las tipologías las crea el administrador y hoy no dicen con qué
   carrocería se dibujan. Mientras exista ese campo (`modelo3d` en
   la configuración), se deduce del nombre. Si no se reconoce, se
   dibuja un camión sencillo: es la forma más común y la que menos
   engaña.
   ========================================================= */

function carroceriaDe(config, registro) {

    const tipologia = buscarTipologia(config, registro.tipologia);
    if (tipologia && tipologia.modelo3d) return tipologia.modelo3d;

    const nombre = ((tipologia && tipologia.nombre) || registro.tipologiaNombre || "").toLowerCase();

    if (/mula|tracto|patineta|articulad|contenedor|40|20 ?pies/.test(nombre)) return "tractomula";
    if (/doble|troque|dt\b|3 ?ejes/.test(nombre)) return "dobleTroque";
    if (/turbo|npr|350|nhr|furgoneta|camioneta|van/.test(nombre)) return "turbo";
    return "sencillo";
}

// "normal/media/alta" del semáforo de siempre → lo que lee el motor.
const NIVEL = { normal: "ok", media: "atencion", alta: "urgente" };

function soportaWebGL() {
    try {
        const c = document.createElement("canvas");
        return !!(window.WebGL2RenderingContext && c.getContext("webgl2"));
    } catch (e) {
        return false;
    }
}

// Los colores del semáforo tal como los define el CSS de la página
// (tablero.css y tema-oscuro.css): así el 3D dice lo mismo que la
// leyenda y sigue el tema claro/oscuro.
function leerSemaforo(nodo) {
    const s = getComputedStyle(nodo);
    const v = (nombre, porDefecto) => (s.getPropertyValue(nombre).trim() || porDefecto);
    return {
        libre: v("--sem-libre", "#B4B2A9"),
        ok: v("--sem-ok", "#3B6D11"),
        atencion: v("--sem-media", "#854F0B"),
        urgente: v("--sem-alta", "#A32D2D")
    };
}


export function crearTableroMuelles3D(contenedor, opciones) {

    opciones = opciones || {};

    if (!soportaWebGL()) return crearTableroMuelles(contenedor, opciones);

    /* El objeto que devolvemos delega en `actual`: primero el 3D,
       y el de siempre si el motor no carga. */
    let actual = null;
    let ultimosDatos = null;

    const tablero3d = montar3D(contenedor, opciones, function alFallar() {
        tablero3d.destruir();
        contenedor.classList.remove("tm3d-contenedor");
        actual = crearTableroMuelles(contenedor, opciones);
        if (ultimosDatos) actual.actualizar(ultimosDatos);
    });
    actual = tablero3d;

    return {
        actualizar: function (datos) { ultimosDatos = datos; actual.actualizar(datos); },
        rotuloConductor: function (config) { return etiquetaCampo(config, "conductor"); },
        destruir: function () { actual.destruir(); }
    };
}


function montar3D(contenedor, opciones, alFallar) {

    contenedor.classList.add("tm3d-contenedor");

    const host = document.createElement("div");
    host.className = "tm3d";
    contenedor.appendChild(host);

    const ficha = construirFicha(opciones.mostrarAvance !== false);
    host.appendChild(ficha.root);

    /* Sin dibujar mientras no se ve. Los paneles tienen varias
       vistas (Dashboard, Registros, Exportar…) y el tablero sigue
       montado en la que no está abierta: dibujar 60 veces por
       segundo una escena que nadie mira le quita fluidez al resto
       en los equipos de las bodegas. */
    let visible = true;
    const observador = typeof IntersectionObserver === "function"
        ? new IntersectionObserver(function (entradas) {
            visible = entradas[entradas.length - 1].isIntersecting;
            if (motor) motor.actualizar({ pausado: !visible });
        })
        : null;
    if (observador) observador.observe(host);

    const fichaPatio = construirFichaPatio();
    host.appendChild(fichaPatio.root);

    let motor = null;
    let datos = null;
    let expandido = false;
    let destruido = false;
    let llegadasAnimadas = false;
    let llegadasProgramadas = false;

    // Lo elegido: un muelle (número) o un vehículo del patio (id).
    let seleccionado = null;
    let seleccionadoPatio = null;

    // Quién estaba en escena (muelle o patio) en la última pintada:
    // sirve para ver quién se fue y dejarlo salir rodando.
    let presentesAntes = new Map();   // id → { vehiculo }
    let salientes = [];
    let operacionAnterior;

    /* La tabla "Vehículos en patio" de la página. Con el 3D andando
       la fila del patio ya está en el tablero, y se oculta para no
       mostrar lo mismo dos veces. Vuelve si el 3D falla o se va. */
    function mostrarTablaPatio(visible) {
        const cuerpo = opciones.reemplazaPatio && document.getElementById(opciones.reemplazaPatio);
        if (!cuerpo) return;
        const marco = cuerpo.closest(".table-wrap, .tabla-wrap") || cuerpo.closest("table");
        const titulo = marco && marco.previousElementSibling;
        [marco, titulo && titulo.matches(".section-header, .subtitulo") ? titulo : null].forEach(function (el) {
            if (el) el.classList.toggle("tm3d-reemplazado", !visible);
        });
    }


    /* ── Lo que dice cada muelle (mismo cálculo que el tablero de
       siempre, ver leerMuelle en tableroMuelles.js) ────────────── */
    function leerMuelle(registro, config) {

        const min = minutosEnMuelle(registro);
        const umbrales = tiemposDe(config, registro.tipologia, faseActual(registro), modalidadDe(registro));
        const nivel = umbrales ? nivelContraMeta(min, umbrales) : "normal";
        const conAvance = requiereAvanceCompleto(registro);
        const fase = faseActual(registro) || "—";
        const pct = conAvance ? (registro.avancePorcentaje || 0) : null;

        let textoMeta;
        if (!umbrales) {
            textoMeta = formatDuration(min) + " en muelle · sin meta (falta tipología)";
        } else {
            textoMeta = formatDuration(min) + " de " + formatDuration(umbrales.meta) +
                (nivel !== "normal" ? " · " + formatDuration(min - umbrales.meta) + " por encima" : "");
        }

        const modalidad = distingueModalidad(config) ? modalidadDe(registro) : "";
        const p = pct || 0;

        return {
            // Lo que lee el motor
            id: registro.id,
            placa: registro.placa || "—",
            fase: fase,
            porcentaje: p,
            ocupacion: fase === "Cargue" ? p / 100 : (pct === null ? 0 : 1 - p / 100),
            modelo3d: carroceriaDe(config, registro),
            cancelado: estaCancelado(registro),
            tipologia: { nombre: registro.tipologiaNombre || "Sin tipología" },
            nivelTiempo: function () { return umbrales ? NIVEL[nivel] : null; },

            // Lo que lee la ficha
            conductor: registro.conductor || "",
            textoTipologia: [registro.tipologiaNombre || "Sin tipología", modalidad].filter(Boolean).join(" · "),
            conAvance: conAvance,
            pct: pct,
            meta: textoMeta,
            sinMeta: !umbrales,
            nivel: nivel,
            minutos: min,
            acciones: typeof opciones.acciones === "function" ? (opciones.acciones(registro) || "") : "",
            extras: typeof opciones.extras === "function" ? (opciones.extras(registro) || "") : ""
        };
    }


    /* ── Un vehículo del patio. La espera y su semáforo salen de
       prioridadDe(), el mismo cálculo con el que todos los paneles
       ORDENAN su tabla de patio; `puesto` es su lugar en esa fila. */
    function leerPatio(registro, config, puesto) {

        const p = prioridadDe(registro, config);
        const fase = faseActual(registro) || registro.tipo || "—";

        let textoMeta = "Esperando " + formatDuration(p.minutos);
        if (p.meta) {
            textoMeta += " de " + formatDuration(p.meta) +
                (p.exceso > 0 ? " · " + formatDuration(p.exceso) + " por encima" : "");
        }

        return {
            // Lo que lee el motor
            vehiculo: {
                id: registro.id,
                placa: registro.placa || "—",
                tipoOperacion: registro.tipo || "—",
                fase: fase,
                porcentaje: 0,
                // Esperando: el que viene a descargar llega lleno y el
                // que viene a cargar, vacío.
                ocupacion: fase === "Cargue" ? 0 : 1,
                modelo3d: carroceriaDe(config, registro),
                cancelado: estaCancelado(registro),
                tipologia: { nombre: registro.tipologiaNombre || "Sin tipología" },
                nivelTiempo: function () { return null; }
            },
            puesto: puesto,
            minutos: p.minutos,
            nivel: NIVEL[p.nivel] || "ok",
            textoEspera: formatDuration(p.minutos),

            // Lo que lee la ficha
            id: registro.id,
            placa: registro.placa || "—",
            conductor: registro.conductor || "",
            textoTipo: [registro.tipo, registro.canal, registro.tipologiaNombre].filter(Boolean).join(" · "),
            meta: textoMeta,
            nivelSemaforo: p.nivel,
            ingreso: registro.horaEntrada,
            operador: registro.operadorEntrada || "",
            acciones: typeof opciones.accionesPatio === "function" ? (opciones.accionesPatio(registro) || "") : ""
        };
    }


    function pintar() {

        if (!datos || destruido) return;

        const numeros = datos.numeros || [];
        const config = datos.config || null;

        /* El administrador cambia de bodega con el mismo tablero.
           Los camiones de la bodega anterior no "salen": se borra la
           escena y entra la nueva, sin animar seis salidas falsas. */
        const operacion = config && config.operacion;
        if (operacion !== operacionAnterior) {
            operacionAnterior = operacion;
            presentesAntes = new Map();
            salientes = [];
            seleccionado = null;
            seleccionadoPatio = null;
        }

        const porMuelle = new Map();
        (datos.registros || []).forEach(function (r) {
            if (r.ubicacion === "Muelle" && !r.horaSalida && r.numeroMuelle != null) {
                porMuelle.set(String(r.numeroMuelle), r);
            }
        });

        const muelles = numeros.map(function (numero) {
            const r = porMuelle.get(String(numero));
            const v = r ? leerMuelle(r, config) : null;
            return { numero: numero, vehiculo: v, minutos: v ? v.minutos : 0 };
        });

        // El patio llega ya en el orden de prioridad del panel. Un
        // panel que no lo pase simplemente no muestra patio.
        const patio = (datos.patio || [])
            .filter(function (r) { return !r.horaSalida && r.ubicacion !== "Muelle"; })
            .map(function (r, i) { return leerPatio(r, config, i + 1); });

        // Los que estaban en escena y ya no están ni en un muelle ni
        // en el patio se van rodando; el motor avisa al salir de cuadro.
        const ahora = new Map();
        muelles.forEach(function (m) { if (m.vehiculo) ahora.set(m.vehiculo.id, { vehiculo: m.vehiculo }); });
        patio.forEach(function (p) { ahora.set(p.id, { vehiculo: p.vehiculo }); });
        presentesAntes.forEach(function (antes, id) {
            if (!ahora.has(id) && !salientes.some(function (s) { return s.vehiculo.id === id; })) {
                salientes = salientes.concat([antes]);
            }
        });
        // Si uno que iba saliendo vuelve, deja de salir.
        salientes = salientes.filter(function (s) { return !ahora.has(s.vehiculo.id); });
        presentesAntes = ahora;

        /* El elegido del patio que pasó a un muelle sigue elegido, ya
           en su muelle: quien lo asignó lo ve llegar con la ficha
           abierta. Si se fue del todo, la ficha se cierra. */
        if (seleccionadoPatio && !patio.some(function (p) { return p.id === seleccionadoPatio; })) {
            const ahoraEn = muelles.find(function (m) { return m.vehiculo && m.vehiculo.id === seleccionadoPatio; });
            seleccionado = ahoraEn ? ahoraEn.numero : null;
            seleccionadoPatio = null;
        }

        const elegido = muelles.find(function (m) { return m.numero === seleccionado; });
        const vehiculoElegido = elegido && elegido.vehiculo;
        const elegidoPatio = patio.find(function (p) { return p.id === seleccionadoPatio; }) || null;

        ficha.pintar(vehiculoElegido ? elegido : null);
        fichaPatio.pintar(elegidoPatio);

        if (motor) {
            const titulo = document.getElementById("muelles-titulo");
            motor.actualizar({
                titulo: (titulo && titulo.textContent.trim()) || "Muelles",
                nombreBodega: "CENTRO DE DISTRIBUCIÓN" + (config && config.operacion ? " · BODEGA " + config.operacion : ""),
                muelles: muelles,
                patio: patio,
                salientes: salientes,
                seleccionado: seleccionado,
                seleccionadoPatio: seleccionadoPatio,
                animarLlegada: llegadasAnimadas,
                expandido: expandido,
                hayFicha: !!vehiculoElegido || !!elegidoPatio,
                semaforo: leerSemaforo(contenedor),
                pausado: !visible
            });

            /* Lo que ya estaba al abrir aparece quieto en su sitio; de
               aquí en adelante, lo que llega entra rodando. Se activa
               después de que el motor alcanzó a montar la escena. */
            if (!llegadasAnimadas && !llegadasProgramadas) {
                llegadasProgramadas = true;
                setTimeout(function () {
                    llegadasAnimadas = true;
                    if (motor) motor.actualizar({ animarLlegada: true });
                }, 1500);
            }
        }
    }


    /* ── Selección, pantalla completa ─────────────────────────── */

    // Un muelle, o null para soltar todo (clic en el piso, cerrar).
    function seleccionar(numero) {
        seleccionado = numero;
        seleccionadoPatio = null;
        pintar();
    }

    function seleccionarPatio(id) {
        seleccionadoPatio = id;
        seleccionado = null;
        pintar();
    }

    function alternarExpandido(valor) {
        expandido = valor;
        host.classList.toggle("tm3d-expandido", expandido);
        document.body.classList.toggle("tm3d-sin-scroll", expandido);

        /* Pantalla completa del NAVEGADOR sobre toda la página, no
           solo sobre el tablero: los modales de los paneles (Salida,
           Mover, Novedades…) viven en el body y tienen que poder
           abrirse por encima del tablero expandido. */
        try {
            if (expandido && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(function () {});
            if (!expandido && document.fullscreenElement) document.exitFullscreen().catch(function () {});
        } catch (e) { /* sin API de pantalla completa: queda el modo expandido */ }

        pintar();
    }

    function alSalirDePantallaCompleta() {
        if (!document.fullscreenElement && expandido) alternarExpandido(false);
    }

    function alPulsarTecla(e) {
        // Esc con un modal abierto lo cierra el panel; aquí solo
        // se encoge el tablero si no hay modal encima.
        if (e.key === "Escape" && expandido && !document.querySelector(".modal-backdrop.open")) {
            alternarExpandido(false);
        }
    }

    document.addEventListener("fullscreenchange", alSalirDePantallaCompleta);
    document.addEventListener("keydown", alPulsarTecla);

    ficha.onCerrar = function () { seleccionar(null); };
    fichaPatio.onCerrar = function () { seleccionar(null); };
    ficha.onDetalle = typeof opciones.onSeleccion === "function"
        ? function (id) { opciones.onSeleccion(id); }
        : null;


    /* ── Carga del motor ─────────────────────────────────────── */

    import("../vendor/muelles3d/muelles3d.js")
        .then(function (m) {
            if (destruido) return;
            motor = m.montarMuelles3D(host, {
                onSeleccionar: seleccionar,
                onSeleccionarPatio: seleccionarPatio,
                onExpandir: alternarExpandido,
                onSalio: function (id) {
                    salientes = salientes.filter(function (s) { return s.vehiculo.id !== id; });
                    pintar();
                }
            });
            mostrarTablaPatio(false);
            pintar();
        })
        .catch(function (error) {
            console.warn("Tablero 3D no disponible, se usa el de siempre:", error);
            if (!destruido) alFallar();
        });


    return {
        actualizar: function (nuevos) {
            datos = nuevos || {};
            pintar();
        },
        destruir: function () {
            destruido = true;
            if (expandido) alternarExpandido(false);
            document.removeEventListener("fullscreenchange", alSalirDePantallaCompleta);
            document.removeEventListener("keydown", alPulsarTecla);
            if (observador) observador.disconnect();
            mostrarTablaPatio(true);
            if (motor) motor.destruir();
            if (host.parentNode) host.parentNode.removeChild(host);
        }
    };
}


/* =========================================================
   LA FICHA DEL VEHÍCULO ELEGIDO

   Es la tarjeta de muelle de siempre (mismas clases tm-*, mismos
   textos), pero de un solo vehículo y flotando sobre la escena.
   Igual que en el tablero de siempre, `extras` y `acciones` se
   reescriben SOLO cuando su HTML cambia: dentro puede haber un
   <select> abierto o un avance a medio mover, y reescribirlo en
   cada snapshot se lo cerraría al supervisor en la cara.
   ========================================================= */

/* `mostrarAvance` es la misma opción del tablero de siempre:
   false donde el panel dibuja su propio avance (editable en el
   supervisor) dentro de `extras` — si no, la ficha enseñaría dos. */
function construirFicha(mostrarAvance) {

    const root = document.createElement("aside");
    root.className = "tm-card tm-ocupado-card tm3d-ficha";
    root.slot = "ficha";
    root.hidden = true;

    root.innerHTML =
        '<header class="tm-head">' +
            '<span class="tm-num"></span>' +
            '<span class="tm-estado">OCUPADO</span>' +
            '<button type="button" class="tm3d-cerrar" aria-label="Cerrar ficha" title="Cerrar"><i class="ti ti-x"></i></button>' +
        '</header>' +
        '<div class="tm-ocupado">' +
            '<div class="tm-placa"></div>' +
            '<div class="tm-conductor"></div>' +
            '<div class="tm-tipologia"></div>' +
            '<div class="tm-extras"></div>' +
            '<div class="tm-avance"><div class="tm-avance-top"><span class="tm-fase"></span><span class="tm-pct"></span></div></div>' +
            '<div class="tm-meta"></div>' +
            '<div class="tm-acciones"></div>' +
            '<button type="button" class="btn btn-sm tm3d-detalle"><i class="ti ti-file-description"></i> Ver ficha completa</button>' +
        '</div>';

    const $ = function (sel) { return root.querySelector(sel); };
    const r = {
        num: $(".tm-num"), placa: $(".tm-placa"), conductor: $(".tm-conductor"),
        tipologia: $(".tm-tipologia"), extras: $(".tm-extras"), avance: $(".tm-avance"),
        fase: $(".tm-fase"), pct: $(".tm-pct"), meta: $(".tm-meta"), acciones: $(".tm-acciones"),
        detalle: $(".tm3d-detalle")
    };

    let viejo = null;

    const ficha = {
        root: root,
        onCerrar: null,
        onDetalle: null,

        pintar: function (muelle) {

            if (!muelle) {
                root.hidden = true;
                viejo = null;
                return;
            }

            const v = muelle.vehiculo;
            const nuevo = viejo === null || viejo.id !== v.id;
            root.hidden = false;
            root.setAttribute("data-vehiculo", v.id);

            r.num.textContent = "M" + muelle.numero;
            if (nuevo || viejo.placa !== v.placa) r.placa.textContent = v.placa;
            if (nuevo || viejo.conductor !== v.conductor) r.conductor.textContent = v.conductor;
            if (nuevo || viejo.textoTipologia !== v.textoTipologia) r.tipologia.textContent = v.textoTipologia;
            if (nuevo || viejo.extras !== v.extras) r.extras.innerHTML = v.extras;

            r.avance.style.display = v.conAvance && mostrarAvance ? "" : "none";
            r.fase.textContent = v.fase;
            r.pct.textContent = v.pct === null ? "" : v.pct + "%";

            if (nuevo || viejo.meta !== v.meta) r.meta.textContent = v.meta;
            r.meta.classList.toggle("tm-sin-meta", v.sinMeta);
            root.classList.toggle("nivel-media", v.nivel === "media");
            root.classList.toggle("nivel-alta", v.nivel === "alta");
            root.classList.toggle("tm-cancelado", v.cancelado);

            if (nuevo || viejo.acciones !== v.acciones) r.acciones.innerHTML = v.acciones;
            r.detalle.style.display = ficha.onDetalle ? "" : "none";

            viejo = v;
        }
    };

    root.addEventListener("click", function (e) {
        if (e.target.closest(".tm3d-cerrar")) { if (ficha.onCerrar) ficha.onCerrar(); return; }
        if (e.target.closest(".tm3d-detalle")) { if (ficha.onDetalle && viejo) ficha.onDetalle(viejo.id); return; }

        // Igual que en la tarjeta de siempre: un clic en la ficha
        // —fuera de los controles— abre la ficha completa.
        if (e.target.closest("button, a, select, input, textarea, label")) return;
        if (ficha.onDetalle && viejo) ficha.onDetalle(viejo.id);
    });

    return ficha;
}


/* =========================================================
   LA FICHA DE UN VEHÍCULO EN PATIO

   Lo mismo que decía su fila en la tabla de patio de la página
   (placa, conductor, tipo, canal, ingreso, espera, operador) y
   los MISMOS botones de esa fila, que pasa cada panel en
   `opciones.accionesPatio`: Mover, Observación y Detalle en
   portería y admin; Novedades en supervisor y clientes.
   ========================================================= */

function formatoIngreso(fecha) {
    if (!fecha) return "—";
    const d = new Date(fecha);
    if (isNaN(d)) return "—";
    return d.toLocaleString("es-CO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function construirFichaPatio() {

    const root = document.createElement("aside");
    root.className = "tm-card tm3d-ficha";
    root.slot = "ficha";
    root.hidden = true;

    root.innerHTML =
        '<header class="tm-head">' +
            '<span class="tm-num"></span>' +
            '<span class="tm-estado">EN PATIO</span>' +
            '<button type="button" class="tm3d-cerrar" aria-label="Cerrar ficha" title="Cerrar"><i class="ti ti-x"></i></button>' +
        '</header>' +
        '<div class="tm-ocupado">' +
            '<div class="tm-placa"></div>' +
            '<div class="tm-conductor"></div>' +
            '<div class="tm-tipologia"></div>' +
            '<div class="tm-meta"></div>' +
            '<div class="tm3d-datos"></div>' +
            '<div class="tm-acciones"></div>' +
        '</div>';

    const $ = function (sel) { return root.querySelector(sel); };
    const r = {
        num: $(".tm-num"), placa: $(".tm-placa"), conductor: $(".tm-conductor"),
        tipo: $(".tm-tipologia"), meta: $(".tm-meta"), datos: $(".tm3d-datos"), acciones: $(".tm-acciones")
    };

    let viejo = null;

    const ficha = {
        root: root,
        onCerrar: null,

        pintar: function (p) {

            if (!p) {
                root.hidden = true;
                viejo = null;
                return;
            }

            const nuevo = viejo === null || viejo.id !== p.id;
            root.hidden = false;
            root.setAttribute("data-vehiculo", p.id);

            r.num.textContent = "Patio · #" + p.puesto;
            r.placa.textContent = p.placa;
            r.conductor.textContent = p.conductor;
            r.tipo.textContent = p.textoTipo;
            r.meta.textContent = p.meta;
            r.datos.textContent = "Ingreso " + formatoIngreso(p.ingreso) + (p.operador ? " · " + p.operador : "");
            root.classList.toggle("nivel-media", p.nivelSemaforo === "media");
            root.classList.toggle("nivel-alta", p.nivelSemaforo === "alta");

            // Solo si cambian, igual que en la ficha del muelle.
            if (nuevo || viejo.acciones !== p.acciones) r.acciones.innerHTML = p.acciones;

            viejo = p;
        }
    };

    root.addEventListener("click", function (e) {
        if (e.target.closest(".tm3d-cerrar") && ficha.onCerrar) ficha.onCerrar();
    });

    return ficha;
}
