/* =========================================================
   INLOTRANS
   Utilidades de fecha y tiempo

   Extraído de bodega-J4.html (funciones ya probadas en
   producción). Sin cambios de lógica — solo se movieron
   aquí para compartirse entre operaciones y roles.
   ========================================================= */

export function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function nowLocal() {
    var now = new Date();
    var off = now.getTimezoneOffset() * 60000;
    return new Date(now - off).toISOString().slice(0, 16);
}

export function today() {
    var now = new Date();
    var off = now.getTimezoneOffset() * 60000;
    return new Date(now - off).toISOString().slice(0, 10);
}

/*
    Valida que una fecha (string 'YYYY-MM-DD' o datetime-local)
    esté entre ayer y hoy — no permite fechas futuras ni de
    hace más de un día.
*/
export function fechaDentroDeRango(valor) {

    if (!valor) return false;

    var fechaStr = valor.slice(0, 10);
    var hoy = new Date(today() + 'T00:00:00');
    var fecha = new Date(fechaStr + 'T00:00:00');
    var ayer = new Date(hoy);
    ayer.setDate(ayer.getDate() - 1);

    return fecha >= ayer && fecha <= hoy;
}

export function fmtDt(s) {
    if (!s) return '—';
    return new Date(s).toLocaleString('es-CO', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
    });
}

export function formatDuration(minutes) {
    if (minutes == null || isNaN(minutes)) return '—';
    minutes = Math.round(minutes);
    if (minutes < 0) return '—';
    var horas = Math.floor(minutes / 60);
    var mins = minutes % 60;
    return horas > 0 ? horas + 'h ' + mins + 'min' : mins + ' min';
}

/* minutosEnPatio() se mudó a services/eventos.js: medir tiempo en
   patio exige leer el historial, y el historial vive allá. Aquí
   medía `ahora − horaEntrada`, que es tiempo en planta. */

export function duracion(entrada, salida) {
    if (!entrada || !salida) return '—';
    var diff = (new Date(salida) - new Date(entrada)) / 60000;
    if (diff < 0) return '—';
    var h = Math.floor(diff / 60), m = Math.round(diff % 60);
    return h === 0 ? m + ' min' : h + 'h ' + m + 'min';
}

/*
    Día operativo: agrupa una fecha/hora bajo el día al que
    pertenece según un corte distinto de medianoche (por defecto
    6am). Todo lo que pasa entre las 00:00 y las 05:59 cuenta
    como parte del día operativo ANTERIOR.

    Ej. con horaCorte=6: un registro con horaEntrada
    '2026-08-24T03:40' devuelve '2026-08-23' (todavía es la
    "noche" del día operativo anterior); uno con horaEntrada
    '2026-08-24T07:10' devuelve '2026-08-24'.

    horaCorte es parametrizable porque J3 (Pepsico) usa 6am,
    pero otras bodegas podrían necesitar otro corte más adelante.
*/
export function diaOperativo(fechaHoraISO, horaCorte) {
    if (horaCorte == null) horaCorte = 6;
    if (!fechaHoraISO) return null;

    var d = new Date(fechaHoraISO);
    if (isNaN(d)) return null;

    var ajustada = new Date(d.getTime());
    ajustada.setHours(ajustada.getHours() - horaCorte);

    var off = ajustada.getTimezoneOffset() * 60000;
    return new Date(ajustada - off).toISOString().slice(0, 10);
}

/*
    El día operativo "de hoy" según la hora actual — para
    filtrar por defecto sin que el panel dependa de que el
    usuario elija una fecha manualmente.
*/
export function todayOperativo(horaCorte) {
    return diaOperativo(new Date().toISOString(), horaCorte);
}

/*
    Suma (o resta, con n negativo) días a una fecha 'YYYY-MM-DD'
    devolviendo otra 'YYYY-MM-DD'.

    Existe porque el patrón que se venía usando en los paneles
    —new Date(dia + 'T00:00:00'), sumar días y volver a
    .toISOString().slice(0,10)— convierte la medianoche LOCAL a
    UTC antes de recortar. En Colombia (UTC-5) eso da la fecha
    correcta de casualidad: la medianoche local son las 05:00Z
    del mismo día. Con cualquier huso positivo (UTC+2, por
    ejemplo) la medianoche local es las 22:00Z del día ANTERIOR y
    todos los rangos de las estadísticas se corren un día.

    Trabajar sobre la fecha en UTC evita el problema por completo:
    no hay hora local de por medio que convertir.
*/
export function sumarDias(diaISO, n) {
    if (!diaISO) return null;
    var d = new Date(diaISO + 'T12:00:00Z');
    if (isNaN(d)) return null;
    d.setUTCDate(d.getUTCDate() + (n || 0));
    return d.toISOString().slice(0, 10);
}
