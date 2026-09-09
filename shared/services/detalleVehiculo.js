/* =========================================================
   INLOTRANS
   Ficha de trazabilidad del vehículo

   El detalle de un vehículo mostraba seis datos —placa, los dos
   campos libres, ubicación, ingreso y programación— y el
   historial. Todo lo demás que el registro fue acumulando con el
   tiempo (tipología, canal, tipo de servicio, las observaciones
   de cada etapa, quién lo recibió y quién lo despachó, si se
   canceló y por qué, si se cobró y cómo) solo existía repartido
   entre columnas de tablas y hojas de Excel: para reconstruir lo
   que pasó con UN vehículo había que cruzar tres pantallas y un
   archivo, y el historial —que sí estaba completo— cuenta los
   eventos, no el estado.

   Esta ficha es ese cruce hecho una sola vez. Vive aquí y no
   copiada en cada panel porque los tres roles miran el mismo
   vehículo: si el supervisor y el operario leen fichas
   distintas, la discusión sobre qué pasó no se puede cerrar.

   ── LO QUE NO SE VE IGUAL EN LOS TRES ──

   El dinero, y solo el dinero. El operario de portería no puede
   ver cuánto pagó un vehículo (ver el encabezado de cobros.js:
   por eso el monto vive en otra colección y en el vehículo solo
   queda un booleano). Él ve si el pago quedó registrado o no
   —que es lo único que necesita para despachar— y el supervisor
   ve el desglose. El cliente no ve ninguna de las dos cosas: las
   reglas de Firestore ni siquiera le dejan leer la colección.

   Esa diferencia se controla desde afuera, con las opciones:
   este módulo pinta lo que se le pasa y no decide permisos. Un
   panel que no deba mostrar el cobro simplemente no lo manda.
   ========================================================= */

import { fmtDt, formatDuration, duracion } from "../utils/tiempos.js";
import { getDestino, getLocationDurations, canalDe } from "./eventos.js";
import { estaCancelado, llegoAunqueCancelado } from "./vehiculos.js";


function escapar(txt) {
    return String(txt == null ? "" : txt).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}

function fmtMoneda(valor) {
    return "$" + Math.round(Number(valor) || 0).toLocaleString("es-CO");
}

function titulo(texto) {
    return '<div class="detail-section-title">' + escapar(texto) + "</div>";
}

/*
    Una fila de la ficha. `largo` es para los textos que escribe
    una persona —observaciones, motivos—: la fila deja de alinear
    al centro y el valor envuelve en varias líneas en vez de
    empujar la etiqueta fuera del modal.
*/
function fila(etiqueta, valor, largo) {
    return '<div class="detail-row' + (largo ? " detail-row-largo" : "") + '">' +
        '<span class="detail-lbl">' + escapar(etiqueta) + ":</span>" +
        '<span class="detail-val">' + escapar(valor) + "</span></div>";
}

/* Filas que solo aparecen si hay algo que poner. Un "—" repetido
   ocho veces esconde los datos que sí están. */
function filaSiHay(etiqueta, valor, largo) {
    return valor ? fila(etiqueta, valor, largo) : "";
}


/* =========================================================
   ESTADO Y TIEMPOS
   ========================================================= */

/*
    En qué punto está el vehículo. Un cancelado NO se rotula
    "Salió" aunque lleve hora de salida: lleva esa hora para que
    deje de ocupar patio, pero no operó, y confundir las dos cosas
    es exactamente lo que ensucia los indicadores (ver el
    encabezado de vehiculos.js).
*/
function estadoDe(rec) {
    if (estaCancelado(rec)) {
        return llegoAunqueCancelado(rec)
            ? "Cancelado — llegó y se fue sin operar"
            : "Cancelado — el vehículo no llegó";
    }
    if (rec.horaSalida) return "Salió";
    return rec.ubicacion === "Muelle" ? "En muelle" : "En patio";
}

/*
    Cuánto lleva o cuánto estuvo. Para un vehículo que sigue
    adentro se cuenta hasta ahora y se dice que va en curso: un
    guion en esa fila haría pensar que el dato se perdió.
*/
function tiempoEnPlanta(rec) {
    if (!rec.horaEntrada) return "—";
    if (rec.horaSalida) return duracion(rec.horaEntrada, rec.horaSalida);
    const minutos = (new Date() - new Date(rec.horaEntrada)) / 60000;
    if (!(minutos >= 0)) return "—";
    return formatDuration(minutos) + " (en curso)";
}

function servicioDe(rec) {
    const tipo = rec.servicioTipo || "Normal";
    return rec.servicioEmpresa ? tipo + " — " + rec.servicioEmpresa : tipo;
}


/* =========================================================
   BLOQUES
   ========================================================= */

/*
    Quién es el vehículo. Los dos campos libres se rotulan como
    los llame la bodega (`etiquetas`): en J3 y B9 son conductor y
    cédula; en J4, proveedor y número de cita.
*/
function bloqueIdentificacion(rec, etiquetas) {
    return titulo("Identificación") +
        fila("Placa", rec.placa || "—") +
        fila(etiquetas.conductor, rec.conductor || "—") +
        fila(etiquetas.cedula, rec.cedula || "—") +

        // "Sin asignar" y no un guion: que falte la tipología no es
        // un dato vacío, es lo que tiene al vehículo sin tarifa y
        // sin metas de tiempo, y quien abre la ficha debe notarlo.
        fila("Tipología", rec.tipologiaNombre || "Sin asignar") +

        // Solo donde se marcó: en las bodegas que no distinguen
        // modalidad este campo no existe, y una fila vacía haría
        // pensar que falta un dato que nadie tenía que llenar.
        filaSiHay("Mercancía", rec.modalidad) +

        fila("Operación", rec.tipo || "—") +
        fila("Canal", rec.canal || canalDe(rec)) +
        fila("Servicio", servicioDe(rec));
}

/*
    La línea de tiempo del vehículo: cuándo entró, con quién,
    dónde estuvo, cuánto tardó en cada sitio y cuándo salió.

    Los tiempos de patio y muelle salen del historial, no de la
    resta entrada−salida: un vehículo que pasó por patio, subió a
    muelle y volvió a patio tiene dos tramos en cada sitio.
*/
function bloqueTrazabilidad(rec, mostrarOperarios) {

    const duraciones = getLocationDurations(rec);

    return titulo("Trazabilidad") +
        fila("Estado", estadoDe(rec)) +
        filaSiHay("Día operativo", rec.fecha) +
        fila("Cita programada", rec.programado && rec.horaProgramacion
            ? fmtDt(rec.horaProgramacion)
            : "Sin cita programada") +
        fila("Ingreso", fmtDt(rec.horaEntrada)) +
        (mostrarOperarios ? filaSiHay("Recibido por", rec.operadorEntrada) : "") +
        fila("Ubicación", getDestino(rec)) +
        fila("Tiempo en patio", formatDuration(duraciones.patio)) +
        fila("Tiempo en muelle", formatDuration(duraciones.muelle)) +
        fila("Tiempo en planta", tiempoEnPlanta(rec)) +
        fila("Salida", fmtDt(rec.horaSalida)) +
        (mostrarOperarios ? filaSiHay("Despachado por", rec.operadorSalida) : "");
}

/*
    Las tres observaciones que puede llevar un registro, cada una
    escrita en un momento distinto de la operación. El bloque
    entero desaparece si no hay ninguna.
*/
function bloqueObservaciones(rec) {

    const filas =
        filaSiHay("De entrada", rec.obs, true) +
        filaSiHay("De ubicación", rec.obsUbicacion, true) +
        filaSiHay("De salida", rec.obsSalida, true);

    return filas ? titulo("Observaciones") + filas : "";
}

/*
    En qué va el cargue o el descargue. El panel de portería NO lo
    pide aquí: pinta su propia barra con el diagnóstico de salida
    justo debajo de la ficha, y repetir la cifra dos veces en la
    misma pantalla solo invita a dudar de cuál de las dos manda.
    Supervisor y cliente sí, que hasta ahora no lo veían en el
    detalle.
*/
function bloqueAvance(rec) {

    // Registros anteriores a la función de avance: nunca se les pidió
    // el dato. Un "0%" ahí se leería como "no ha hecho nada".
    if (rec.avanceTipo == null && rec.avancePorcentaje == null) {
        return titulo("Avance de la operación") +
            fila("Avance", "Sin registrar — es un registro anterior a esta función");
    }

    return titulo("Avance de la operación") +
        fila("Fase actual", rec.avanceTipo || rec.tipo || "—") +
        fila("Avance", (rec.avancePorcentaje || 0) + "%") +

        // Un cargue que iba a medias y se devolvió a descargue: el
        // porcentaje quedó guardado para retomarlo. Sin esta fila, ese
        // trabajo desaparece de la vista y parece que se perdió.
        filaSiHay("Cargue pendiente", rec.avanceCarguePendiente
            ? rec.avanceCarguePendiente + "% ya hecho, se retoma al terminar el descargue"
            : "");
}

function bloqueCancelacion(rec) {

    if (!estaCancelado(rec)) return "";

    const c = rec.cancelacion || {};

    return titulo("Cancelación") +
        fila("¿Llegó el vehículo?", c.llego ? "Sí — entró y se fue sin operar" : "No — la cita se canceló") +
        filaSiHay("Cancelado el", c.fecha ? fmtDt(c.fecha) : "") +
        filaSiHay("Cancelado por", c.canceladoPor) +
        fila("Motivo", c.motivo || "—", true);
}

/*
    El cobro, con el desglose congelado que se guardó el día que
    se registró: la tabla de tarifas cambia y el arqueo de ese
    turno tiene que poder rehacerse con los números de entonces.

    Solo lo recibe el panel de supervisor. Ver el encabezado.
*/
function bloqueCobro(rec, cobro) {

    if (!cobro) return "";

    const facturado = cobro.porFactura || cobro.soporte === "Facturado al cliente";

    return titulo("Cobro") +
        fila("Soporte", cobro.soporte || "—") +
        fila("Medio de pago", facturado ? "No entró a caja — se factura al cliente" : (cobro.medio || "—")) +
        fila("Tarifa cobrada", fmtMoneda(cobro.tarifa)) +
        (facturado ? "" :
            fila("Efectivo", fmtMoneda(cobro.montoEfectivo)) +
            fila("QR", fmtMoneda(cobro.montoQR))) +
        fila("IVA liquidado", fmtMoneda(cobro.iva)) +
        fila("Valor cuadrilla", fmtMoneda(cobro.totalCuadrilla)) +
        fila("Tasa INLO", fmtMoneda(cobro.tasaInlo)) +
        filaSiHay("Registrado por", cobro.registradoPor) +
        filaSiHay("Corregido por", cobro.editadoPor);
}

/*
    Lo único que el operario puede saber del pago: si ya se
    registró. Es el dato que destraba la salida y no revela ni
    cuánto ni cómo se pagó.
*/
function bloquePago(rec) {
    return titulo("Pago") +
        fila("Estado del pago", rec.pagoRegistrado ? "Registrado" : "Pendiente por registrar");
}


/* =========================================================
   LA FICHA COMPLETA

   Devuelve el HTML de los bloques comunes. El avance, la
   autorización de salida y el historial los agrega cada panel
   después, porque los pinta con sus propios controles (el
   supervisor puede mover el avance desde ahí; el cliente no).

   opciones:
      etiquetas          { conductor, cedula } — cómo llama esta
                         bodega a los dos campos libres
      mostrarOperarios   quién recibió y quién despachó
      mostrarAvance      fase y porcentaje. En false para el panel
                         que ya pinta su propia barra de avance
      cobro              el documento de cobro, o null. Solo el
                         supervisor lo tiene
      mostrarPago        pinta el bloque de "pago registrado sí/no"
                         (portería, en las bodegas que cobran)
   ========================================================= */

export function fichaVehiculo(rec, opciones) {

    if (!rec) return "";

    const o = opciones || {};
    const etiquetas = o.etiquetas || {};

    return bloqueIdentificacion(rec, {
        conductor: etiquetas.conductor || "Conductor",
        cedula: etiquetas.cedula || "Cédula / documento"
    }) +
        bloqueTrazabilidad(rec, o.mostrarOperarios !== false) +
        (o.mostrarAvance !== false ? bloqueAvance(rec) : "") +
        bloqueObservaciones(rec) +
        bloqueCancelacion(rec) +
        (o.cobro ? bloqueCobro(rec, o.cobro) : (o.mostrarPago ? bloquePago(rec) : ""));
}
