/* =========================================================
   INLOTRANS
   Integridad de los datos: reglas puras (sin Firebase)

   Tres problemas que dañaban la trazabilidad cuando varias personas
   trabajan a la vez:

     1. LA MISMA PLACA DOS VECES. Dos operarios la registran en el
        mismo segundo: los dos pasan la revisión de su pantalla y
        quedan dos registros activos.

     2. LA SALIDA DOS VECES. Dos clics (o dos personas) en "Salida":
        el historial recibía dos eventos y la segunda pisaba la hora
        y el operario de la primera.

     3. EL AVANCE PISADO. Dos supervisores ven 40 %; uno sube +10 y
        el otro +5: gana el último y el trabajo del primero se pierde.
        Y era posible llevarlo de 0 a 100 de una sola tanda.

   Aquí vive lo que se DECIDE (qué se rechaza y con qué mensaje). Lo que
   se HACE de forma atómica (transacciones de Firestore) vive en
   vehiculos.js. Va en un archivo sin Firebase para poder probarlo.

   LOS NÚMEROS DE ABAJO SON DECISIÓN DE NEGOCIO, no técnica: son el valor
   de partida y se pueden cambiar aquí (a futuro, desde la configuración
   de la bodega). Los mensajes son provisionales.
   ========================================================= */

/* ── Límites del avance ──────────────────────────────────── */

// Lo máximo que sube el avance en UNA solicitud.
export const TOPE_SALTO_AVANCE = 25;

// Una "tanda" son las subidas hechas en los últimos N minutos. Lo máximo
// que puede subir en una tanda: así no se llega de 0 a 100 de un golpe,
// ni a base de clics seguidos. Un descargue real avanza sin problema
// bajo este ritmo (100 % en ~7 min de tandas llenas); lo que se frena es
// el atajo.
export const VENTANA_TANDA_MIN = 2;
export const TOPE_TANDA = 30;


/* ── Errores ─────────────────────────────────────────────── */

/*
    Un rechazo por integridad: no es un fallo de red ni un bug, es el
    sistema diciendo "esto no se puede guardar así". Por eso es una clase
    aparte: las pantallas lo reconocen y lo muestran como alerta, en vez
    de tratarlo como "error al guardar, reintenta" (que invitaría a
    insistir justo en lo que no debe repetirse).
*/
export class ErrorIntegridad extends Error {
    constructor(codigo, mensaje, detalle) {
        super(mensaje);
        this.name = "ErrorIntegridad";
        this.codigo = codigo;
        this.detalle = detalle || {};
    }
}

export const esErrorIntegridad = (e) => !!e && e.name === "ErrorIntegridad";


/* ── Placas ──────────────────────────────────────────────── */

// "SVD 390", "svd390 " y "SVD-390" son la misma placa.
export const claveDePlaca = (placa) => String(placa || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Un candado por placa ACTIVA y por operación: el mismo camión puede estar
// en dos bodegas distintas (son clientes distintos), pero no dos veces en una.
export const idCandado = (operacion, placa) => operacion + "_" + claveDePlaca(placa);

// "2026-10-19T14:05" → "14:05 del 2026-10-19"
const cuando = (fecha) => {
    const s = String(fecha || "");
    return s.length >= 16 ? s.slice(11, 16) + " del " + s.slice(0, 10) : (s || "hace un momento");
};

export function errorDuplicado(activo) {
    const donde = activo.destino || activo.ubicacion || "la planta";
    return new ErrorIntegridad(
        "PLACA_DUPLICADA",
        "La placa " + activo.placa + " ya está registrada y activa en " + donde +
        " (la registró " + (activo.operadorEntrada || "otro usuario") + ", " + cuando(activo.horaEntrada) + "). " +
        "No se creó un segundo registro: si es el mismo vehículo, trabaja sobre el que ya existe.",
        { vehiculoId: activo.id || null, placa: activo.placa }
    );
}

export function errorYaSalio(r, que) {
    const cancelado = !!r.cancelado;
    return new ErrorIntegridad(
        "YA_SALIO",
        cancelado
            ? "Este vehículo ya fue cancelado (" + (r.operadorSalida || "otro usuario") + ", " + cuando(r.horaSalida) + ")."
            : "Este vehículo ya tiene su salida registrada por " + (r.operadorSalida || "otro usuario") + " (" + cuando(r.horaSalida) + "). " +
              (que === "avance" ? "Ya no se puede cambiar su avance."
                  : que === "ubicacion" ? "Ya no se puede mover."
                  : "No se registró una segunda salida."),
        { operadorSalida: r.operadorSalida || "", horaSalida: r.horaSalida || "" }
    );
}

export function errorConflictoAvance(actual, vio) {
    return new ErrorIntegridad(
        "AVANCE_CAMBIO",
        "Otro usuario ya actualizó este avance: ahora está en " + actual + "% (tu pantalla mostraba " + vio + "%). " +
        "No se guardó tu cambio para no pisar el suyo. Revisa el valor actual y vuelve a intentarlo.",
        { actual: actual, vio: vio }
    );
}


/* ── Validar una subida de avance ────────────────────────── */

/*
    Decide si el avance puede pasar de `actual` a `nuevo`. Devuelve null
    (se puede) o el ErrorIntegridad con el motivo. Bajar el avance, o dejar
    el mismo, siempre se puede: el control es sobre las SUBIDAS.

      historial   el del vehículo: de ahí salen las subidas de la tanda.
                  Solo cuentan las entradas de avance con `anterior` (las
                  que escribe actualizarAvance), de la misma fase.
      ahora       un Date (se inyecta para poder probar).
      excepcion   true salta todo (backfill del administrador).
*/
export function validarAvance({ actual, nuevo, historial, avanceTipo, ahora, excepcion }) {

    if (excepcion) return null;
    if (!(nuevo > actual)) return null;

    const salto = nuevo - actual;

    if (salto > TOPE_SALTO_AVANCE) {
        return new ErrorIntegridad(
            "AVANCE_SALTO",
            "No puedes subir el avance " + salto + " puntos de una sola vez (máximo " + TOPE_SALTO_AVANCE + " por solicitud). " +
            "Registra el avance a medida que se va cargando o descargando, siguiendo el proceso.",
            { salto: salto, tope: TOPE_SALTO_AVANCE }
        );
    }

    // La tanda: lo que ya se subió en la ventana + esto.
    const desde = (ahora || new Date()).getTime() - VENTANA_TANDA_MIN * 60000;

    const recientes = (Array.isArray(historial) ? historial : []).filter(function (h) {
        return h && h.tipo === "avance" && typeof h.anterior === "number" &&
               (!avanceTipo || !h.avanceTipo || h.avanceTipo === avanceTipo) &&
               new Date(h.fecha).getTime() >= desde;
    });

    // De dónde arrancó la tanda: el menor valor "anterior" de la ventana.
    const base = recientes.reduce(function (min, h) { return Math.min(min, h.anterior); }, actual);
    const enTanda = nuevo - base;

    if (enTanda > TOPE_TANDA) {
        return new ErrorIntegridad(
            "AVANCE_TANDA",
            "Estás subiendo el avance demasiado rápido: " + enTanda + " puntos en menos de " + VENTANA_TANDA_MIN + " minutos " +
            "(máximo " + TOPE_TANDA + "). No se puede cargar el avance de una sola tanda; registra el avance real, " +
            "a medida que avanza la operación, y siguiendo el proceso.",
            { enTanda: enTanda, tope: TOPE_TANDA, ventanaMin: VENTANA_TANDA_MIN }
        );
    }

    return null;
}
