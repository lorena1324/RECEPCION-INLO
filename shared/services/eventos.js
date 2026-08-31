/* =========================================================
   INLOTRANS
   Historial de eventos y prioridad por tiempo de espera

   Extraído de bodega-J4.html. Esta es la base del punto 8
   (tiempos por etapa) y del punto 9 (alertas) de tu prompt
   maestro: cada registro guarda un array `historial` con
   los eventos que le han ocurrido (entrada, cambios de
   ubicación, salida), y de ahí se calculan los tiempos.
   ========================================================= */

import { minutosEnPatio, diaOperativo } from "../utils/tiempos.js";


/* ── HISTORIAL ── */

// Agrega una entrada nueva al historial de un registro sin perder las anteriores.
export function agregarHistorial(rec, entrada) {
    var hist = Array.isArray(rec.historial) ? rec.historial.slice() : [];
    hist.push(entrada);
    return hist;
}

/*
    Devuelve el historial de un registro. Si es un registro antiguo
    sin historial guardado, lo reconstruye con los campos sueltos
    que ya existían (obs, obsUbicacion, obsSalida) para no perder
    esa información.
*/
export function getHistorial(r) {

    if (Array.isArray(r.historial) && r.historial.length) return r.historial;

    var h = [];

    if (r.horaEntrada) {
        h.push({
            fecha: r.horaEntrada,
            tipo: 'entrada',
            operador: r.operadorEntrada,
            ubicacion: getDestino(r),
            texto: r.obs || ''
        });
    }

    if (r.obsUbicacion) {
        h.push({
            fecha: r.horaEntrada,
            tipo: 'ubicacion',
            operador: r.operadorEntrada,
            ubicacion: getDestino(r),
            texto: r.obsUbicacion
        });
    }

    if (r.horaSalida) {
        h.push({
            fecha: r.horaSalida,
            tipo: 'salida',
            operador: r.operadorSalida,
            texto: r.obsSalida || ''
        });
    }

    return h;
}

export function getDestino(r) {
    // 'destino' es el campo actual; 'muelle' se mantiene por compatibilidad con registros antiguos
    return r.destino || r.muelle || '—';
}


/* ── TIEMPOS POR UBICACIÓN (punto 8 del prompt maestro) ── */

/*
    Calcula minutos totales en Patio y en Muelle a partir del
    historial de eventos de un registro (no de un simple
    horaEntrada/horaSalida).
*/
export function getLocationDurations(r) {

    var hist = getHistorial(r).slice().sort(function (a, b) {
        return new Date(a.fecha || 0) - new Date(b.fecha || 0);
    });

    var patio = 0, muelle = 0;
    var lastLoc = null, lastTime = null;

    hist.forEach(function (item) {

        var fecha = new Date(item.fecha || 0);

        if (item.tipo === 'entrada') {
            lastLoc = (item.ubicacion || '').indexOf('Patio') === 0 ? 'Patio'
                : (item.ubicacion || '').indexOf('Muelle') === 0 ? 'Muelle' : null;
            lastTime = fecha;
            return;
        }

        if (item.tipo === 'ubicacion') {
            if (lastLoc && lastTime) {
                var diff = (fecha - lastTime) / 60000;
                if (diff > 0) {
                    if (lastLoc === 'Patio') patio += diff;
                    else if (lastLoc === 'Muelle') muelle += diff;
                }
            }
            lastLoc = (item.ubicacion || '').indexOf('Patio') === 0 ? 'Patio'
                : (item.ubicacion || '').indexOf('Muelle') === 0 ? 'Muelle' : lastLoc;
            lastTime = fecha;
            return;
        }

        if (item.tipo === 'salida') {
            if (lastLoc && lastTime) {
                var diff = (fecha - lastTime) / 60000;
                if (diff > 0) {
                    if (lastLoc === 'Patio') patio += diff;
                    else if (lastLoc === 'Muelle') muelle += diff;
                }
            }
            lastLoc = null;
            lastTime = null;
        }
    });

    if (!r.horaSalida && lastLoc && lastTime) {
        var diffActivo = (new Date() - lastTime) / 60000;
        if (diffActivo > 0) {
            if (lastLoc === 'Patio') patio += diffActivo;
            else if (lastLoc === 'Muelle') muelle += diffActivo;
        }
    }

    return { patio: Math.round(patio), muelle: Math.round(muelle) };
}

export function requiereObservacionLargaEstadia(r) {
    return r && !r.horaSalida && r.ubicacion === 'Patio' && minutosEnPatio(r) >= 240;
}


/* ── PRIORIDAD POR TIEMPO DE ESPERA (punto 9 del prompt maestro) ── */

// Mientras más tiempo lleve un vehículo activo (sin salida), mayor su prioridad.
export function minutosEsperando(r) {
    if (!r || !r.horaEntrada || r.horaSalida) return 0;
    var diff = (new Date() - new Date(r.horaEntrada)) / 60000;
    return diff < 0 ? 0 : diff;
}

/*
    Ordena una lista de registros: primero los activos (sin salida),
    de mayor a menor tiempo de espera; luego los que ya salieron,
    del más reciente al más antiguo.
*/
export function ordenarPorPrioridad(list) {
    return list.slice().sort(function (a, b) {
        var aActivo = !a.horaSalida, bActivo = !b.horaSalida;
        if (aActivo && !bActivo) return -1;
        if (!aActivo && bActivo) return 1;
        if (aActivo && bActivo) return minutosEsperando(b) - minutosEsperando(a);
        return new Date(b.horaSalida || 0) - new Date(a.horaSalida || 0);
    });
}

/*
    Nivel de urgencia según el tiempo de espera.

    IMPORTANTE (punto 9 de tu prompt maestro): estos umbrales
    (120/240 min) hoy están fijos, igual que en bodega-J4.html.
    Cuando construyamos el panel de administrador, se moverán a
    un documento de configuración por operación en Firestore
    (ej. config/{operacion} → { patioMaximo, muelleMaximo }) para
    que cada operación tenga sus propios umbrales.
*/
export function nivelPrioridad(minutos) {
    if (minutos >= 240) return 'alta';
    if (minutos >= 120) return 'media';
    return 'normal';
}


/* ── ETIQUETAS DE HISTORIAL (para UI) ── */

export function iconoHistorial(tipo) {
    return tipo === 'entrada' ? 'ti-login'
        : tipo === 'salida' ? 'ti-logout'
        : tipo === 'operacion' ? 'ti-transfer-in'
        : tipo === 'canal' ? 'ti-route'
        : tipo === 'avance' ? 'ti-percentage'
        : tipo === 'autorizacion' ? 'ti-shield-check'
        : 'ti-edit';
}

export function tituloHistorial(item) {

    if (item.tipo === 'entrada') {
        return 'Entrada registrada' + (item.ubicacion ? ' — ' + item.ubicacion : '');
    }

    if (item.tipo === 'salida') {
        return 'Salida registrada';
    }

    if (item.tipo === 'avance') {
        return 'Avance de cargue/descargue actualizado';
    }

    if (item.tipo === 'autorizacion') {
        return 'Salida anticipada autorizada por el supervisor';
    }

    if (item.tipo === 'ubicacion') {
        return item.ubicacionAnterior && item.ubicacionAnterior !== item.ubicacion
            ? 'Ubicación actualizada: ' + item.ubicacionAnterior + ' → ' + item.ubicacion
            : 'Ubicación confirmada' + (item.ubicacion ? ' — ' + item.ubicacion : '');
    }

    if (item.tipo === 'operacion') {
        return item.tipoAnterior && item.tipoAnterior !== item.tipoNuevo
            ? 'Tipo de operación actualizado: ' + item.tipoAnterior + ' → ' + item.tipoNuevo
            : 'Tipo de operación confirmado' + (item.tipoNuevo ? ' — ' + item.tipoNuevo : '');
    }

    if (item.tipo === 'canal') {
        return item.canalAnterior && item.canalAnterior !== item.canalNuevo
            ? 'Canal actualizado: ' + item.canalAnterior + ' → ' + item.canalNuevo
            : 'Canal confirmado' + (item.canalNuevo ? ' — ' + item.canalNuevo : '');
    }

    return 'Actualización';
}


/* ── DÍA OPERATIVO (corte distinto de medianoche, ej. 6am–6am) ──

   r.fecha (calculado en vehiculos.js como horaEntrada.slice(0,10))
   sigue siendo el día CALENDARIO — no lo tocamos, porque puede que
   se use en otro lado. Para paneles (supervisor, clientes) que
   necesiten agrupar por turno real, usar estas funciones en vez
   de comparar contra r.fecha directamente.
*/

// A qué día operativo pertenece la ENTRADA de un registro.
export function getDiaOperativo(r, horaCorte) {
    return diaOperativo(r && r.horaEntrada, horaCorte);
}

/*
    Agrupa una lista de registros por día operativo, contando
    entradas y salidas de cada día por separado (una salida puede
    caer en un día operativo distinto al de su entrada, si el
    vehículo pasó la noche).
*/
export function agruparPorDiaOperativo(registros, horaCorte) {
    var mapa = {};

    (registros || []).forEach(function (r) {
        if (r.horaEntrada) {
            var dEnt = diaOperativo(r.horaEntrada, horaCorte);
            if (dEnt) {
                if (!mapa[dEnt]) mapa[dEnt] = { entradas: 0, salidas: 0 };
                mapa[dEnt].entradas++;
            }
        }
        if (r.horaSalida) {
            var dSal = diaOperativo(r.horaSalida, horaCorte);
            if (dSal) {
                if (!mapa[dSal]) mapa[dSal] = { entradas: 0, salidas: 0 };
                mapa[dSal].salidas++;
            }
        }
    });

    return mapa;
}

/*
    El día operativo con más movimiento (entradas + salidas) de
    toda la lista de registros que se le pase. Devuelve
    { dia, entradas, salidas, total } o null si no hay datos.
*/
export function diaConMasMovimiento(registros, horaCorte) {
    var mapa = agruparPorDiaOperativo(registros, horaCorte);
    var mejor = null;

    Object.keys(mapa).forEach(function (dia) {
        var total = mapa[dia].entradas + mapa[dia].salidas;
        if (!mejor || total > mejor.total) {
            mejor = { dia: dia, entradas: mapa[dia].entradas, salidas: mapa[dia].salidas, total: total };
        }
    });

    return mejor;
}