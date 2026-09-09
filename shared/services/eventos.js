/* =========================================================
   INLOTRANS
   Historial de eventos y prioridad por tiempo de espera

   Extraído de bodega-J4.html. Esta es la base del punto 8
   (tiempos por etapa) y del punto 9 (alertas) de tu prompt
   maestro: cada registro guarda un array `historial` con
   los eventos que le han ocurrido (entrada, cambios de
   ubicación, salida), y de ahí se calculan los tiempos.
   ========================================================= */

import { diaOperativo } from "../utils/tiempos.js";

import {
    tiemposDe,
    umbralesPatio,
    modalidadDe,
    metaPromedioMuelle
} from "./config.js";


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

/* ── PROMEDIOS DE TIEMPO ──────────────────────────────────

   Un promedio de "tiempo en patio" o "tiempo en muelle" solo
   tiene sentido sobre visitas TERMINADAS. Para un vehículo que
   todavía está adentro, getLocationDurations() cuenta hasta
   `new Date()`, así que su tramo abierto crece en cada repintado:
   meterlo en un promedio da un número que cambia solo cada vez que
   se mira el panel y que además está a medio hacer (un camión que
   entró hace 5 minutos "promedia" 5 minutos, no las 3 horas que va
   a terminar tardando).

   Este es el único sitio donde se decide qué vehículos entran a un
   promedio, para que las tarjetas, las gráficas y las tablas de los
   paneles no puedan volver a contar cosas distintas bajo el mismo
   rótulo.

   `promedio` viene en null —no en 0— cuando no queda ninguna visita
   que medir: 0 min se lee como "salen rapidísimo" cuando en realidad
   es "todavía no hay con qué medir".
   ───────────────────────────────────────────────────────── */

export function visitasTerminadas(recs) {
    return (recs || []).filter(function (r) { return r && r.horaSalida; });
}

/*
    Una visita "no medible": estuvo en planta un rato real
    (entrada → salida) pero el historial no atribuye ni un minuto
    a Patio ni a Muelle. Pasa con registros viejos sin `destino`
    reconocible, y cuando la hora de salida se digita ANTES del
    último cambio de ubicación (esa hora la teclea el operario, el
    cambio de ubicación lo sella el reloj) — getLocationDurations()
    descarta los tramos negativos y el registro queda en cero.

    Promediarlas como si fueran ceros hunde el promedio: un camión
    del que no sabemos cuánto tardó no es un camión que tardó nada.
    Se excluyen del cálculo y se cuentan aparte, para que el dato
    sucio se pueda ver en vez de disolverse en la cifra.
*/
function noMedible(r, dur) {
    if ((dur.patio || 0) + (dur.muelle || 0) > 0) return false;
    var span = (new Date(r.horaSalida) - new Date(r.horaEntrada)) / 60000;
    return span > 1;
}

/*
    Promedio de minutos en una ubicación ('patio' | 'muelle')
    sobre las visitas que REALMENTE pasaron por ahí.

    Un vehículo que entró directo a muelle no esperó 0 minutos en
    patio: no estuvo en patio. Meterlo al promedio de patio como un
    cero no baja el promedio, lo falsea — y como el reparto entre
    entradas directas a muelle y entradas a patio cambia día a día,
    el "tiempo promedio en patio" subía y bajaba por razones que no
    tienen nada que ver con lo que se demora la espera. Lo mismo al
    revés con el muelle.

    Devuelve:
      promedio    minutos (null si no quedó ninguna visita que medir)
      n           visitas que sustentan el promedio
      sinPaso     visitas terminadas que no pasaron por esa ubicación
      descartadas visitas terminadas sin tiempos utilizables
*/
export function promedioMinutos(recs, ubicacion) {

    var total = 0, n = 0, descartadas = 0, sinPaso = 0;

    visitasTerminadas(recs).forEach(function (r) {

        var dur = getLocationDurations(r);

        if (noMedible(r, dur)) { descartadas++; return; }

        var min = dur[ubicacion] || 0;
        if (min <= 0) { sinPaso++; return; }

        total += min;
        n++;
    });

    return {
        promedio: n ? Math.round(total / n) : null,
        n: n,
        sinPaso: sinPaso,
        descartadas: descartadas
    };
}


/*
    Minutos que un vehículo ACTIVO lleva acumulados en patio.

    Vivía en utils/tiempos.js midiendo `ahora − horaEntrada`, que no
    es tiempo en patio sino tiempo en planta: a un vehículo que hizo
    Patio → Muelle → Patio le contaba también las horas del muelle, y
    el aviso de "más de 4h en patio" se disparaba antes de tiempo.
    Aquí se calcula desde el historial, que es donde está el dato
    real, y por eso vive en este módulo y no allá.
*/
export function minutosEnPatio(r) {
    if (!r || !r.horaEntrada || r.horaSalida) return 0;
    return getLocationDurations(r).patio || 0;
}


export function requiereObservacionLargaEstadia(r) {
    return r && !r.horaSalida && r.ubicacion === 'Patio' && minutosEnPatio(r) >= 240;
}


/* ── CANAL ────────────────────────────────────────────────

   La lista es MQ / 3PD / Otro. "Otro" absorbe todo lo demás:
   los registros viejos que quedaron en "Sin canal" (cuando esa
   era la opción por defecto del formulario) y los que nunca
   trajeron el campo. Se normaliza en la lectura, no en la base:
   nada reescribe Firestore, así que si mañana se quiere separar
   "sin registrar" de "otro canal", el dato original sigue ahí.
   ───────────────────────────────────────────────────────── */

export const CANALES = ['MQ', '3PD', 'Otro'];

export function canalDe(r) {
    var c = (r && r.canal ? String(r.canal) : '').trim().toUpperCase();
    if (c === 'MQ') return 'MQ';
    if (c.indexOf('3PD') !== -1) return '3PD';
    return 'Otro';
}


/* ── CUMPLIMIENTO DE CITA (ON TIME) ───────────────────────

   Compara la llegada real (horaEntrada) contra la hora que traía
   programada (horaProgramacion). Negativo = llegó antes de la
   cita; positivo = llegó tarde.

   Solo entran los vehículos programados y con hora de cita: un
   vehículo sin cita no llega ni temprano ni tarde, no tiene
   contra qué medirse. Se cuentan aparte para que el panel pueda
   decir sobre cuántos vehículos está calculando el indicador.

   Tramos (contiguos, sin huecos, definidos por el cliente):
       31+ min antes    rojo
       11 a 30 antes    amarillo
       0 a 10 (± cita)  verde
       11 a 30 después  amarillo
       31+ min después  rojo
   ───────────────────────────────────────────────────────── */

export const TRAMOS_ONTIME = [
    { clave: 'muy-temprano', etiqueta: '31+ min antes',    color: 'rojo'     },
    { clave: 'temprano',     etiqueta: '11 a 30 antes',    color: 'amarillo' },
    { clave: 'en-hora',      etiqueta: 'En hora (± 10 min)', color: 'verde'  },
    { clave: 'tarde',        etiqueta: '11 a 30 después',  color: 'amarillo' },
    { clave: 'muy-tarde',    etiqueta: '31+ min después',  color: 'rojo'     }
];

/*
    Minutos de desfase, ya corregidos por cruce de medianoche.

    La hora de la cita se captura solo como HH:MM y la fecha se
    deriva de la entrada, así que una cita a las 23:50 con llegada
    a las 00:10 daría −23h40 en vez de +20 min. Cuando la
    diferencia pasa de 12 horas, lo que ocurrió fue un cruce de
    día, no un desfase de un día entero: se corrige aquí. Esto
    también endereza los registros viejos, guardados cuando la
    cita se estampaba con la fecha del día en que se digitaba y
    no con la de la entrada.
*/
function minutosDesfase(r) {

    if (!r || !r.programado || !r.horaProgramacion || !r.horaEntrada) return null;

    var cita = new Date(r.horaProgramacion);
    var llegada = new Date(r.horaEntrada);
    if (isNaN(cita) || isNaN(llegada)) return null;

    var min = (llegada - cita) / 60000;

    if (min > 720) min -= 1440;
    else if (min < -720) min += 1440;

    return Math.round(min);
}

export function clasificarOnTime(r) {

    var min = minutosDesfase(r);
    if (min === null) return null;

    var clave;
    if (min <= -31) clave = 'muy-temprano';
    else if (min <= -11) clave = 'temprano';
    else if (min <= 10) clave = 'en-hora';
    else if (min <= 30) clave = 'tarde';
    else clave = 'muy-tarde';

    var tramo = TRAMOS_ONTIME.find(function (t) { return t.clave === clave; });

    return { minutos: min, clave: clave, etiqueta: tramo.etiqueta, color: tramo.color };
}

/*
    Reparte una lista de registros en los cinco tramos.

    `total` es sobre cuántos vehículos se calculan los porcentajes
    (los que tienen cita), y `sinCita` los que quedaron fuera del
    indicador. Mostrar los dos evita leer "80% en hora" sin saber
    que se calculó sobre cinco vehículos de cuarenta.
*/
export function resumenOnTime(recs) {

    var conteo = {};
    TRAMOS_ONTIME.forEach(function (t) { conteo[t.clave] = 0; });

    var total = 0, sinCita = 0;

    (recs || []).forEach(function (r) {
        var c = clasificarOnTime(r);
        if (!c) { sinCita++; return; }
        conteo[c.clave]++;
        total++;
    });

    return {
        total: total,
        sinCita: sinCita,
        tramos: TRAMOS_ONTIME.map(function (t) {
            return {
                clave: t.clave,
                etiqueta: t.etiqueta,
                color: t.color,
                n: conteo[t.clave],
                pct: total ? Math.round((conteo[t.clave] / total) * 100) : 0
            };
        })
    };
}


/* ── PRIORIDAD POR TIEMPO DE ESPERA (punto 9 del prompt maestro) ── */

// Mientras más tiempo lleve un vehículo activo (sin salida), mayor su prioridad.
export function minutosEsperando(r) {
    if (!r || !r.horaEntrada || r.horaSalida) return 0;
    var diff = (new Date() - new Date(r.horaEntrada)) / 60000;
    return diff < 0 ? 0 : diff;
}

/*
    Ordena una lista de registros: primero los activos (sin salida)
    por urgencia, luego los que ya salieron, del más reciente al más
    antiguo.

    ── QUÉ ES "MÁS URGENTE" ──

    Antes era simplemente el que llevaba más rato adentro. Eso
    ordenaba bien una fila de patio —donde esperar es esperar y
    todos se miden contra el mismo límite— pero mentía en cuanto
    entraba un vehículo de muelle: una mula que lleva 50 minutos
    sobre una meta de 45 va MÁS retrasada que otra que lleva 2 horas
    sobre una meta de 3h30, y la vieja regla las ponía al revés.

    Ahora cada vehículo se mide contra SU meta —la de su tipología
    y su fase si está en muelle, la de patio de la bodega si está
    esperando— y manda:

        1. cuántos minutos lleva POR ENCIMA de su meta
        2. si nadie se ha pasado, qué tanto de su meta lleva gastado
        3. y solo al final, el tiempo total adentro, para desempatar

    `config` es la configuración de la bodega. Sin ella no hay metas
    que consultar y el orden queda como estaba: por tiempo adentro.
*/
export function ordenarPorPrioridad(list, config) {

    // Se calcula una vez por registro y no dentro del comparador:
    // getLocationDurations() recorre el historial completo, y un
    // sort lo llamaría O(n log n) veces sobre el mismo vehículo.
    var peso = new Map();
    (list || []).forEach(function (r) { peso.set(r, prioridadDe(r, config)); });

    return list.slice().sort(function (a, b) {

        var aActivo = !a.horaSalida, bActivo = !b.horaSalida;
        if (aActivo && !bActivo) return -1;
        if (!aActivo && bActivo) return 1;

        if (aActivo && bActivo) {
            var pa = peso.get(a), pb = peso.get(b);
            if (pb.exceso !== pa.exceso) return pb.exceso - pa.exceso;
            if (pb.consumo !== pa.consumo) return pb.consumo - pa.consumo;
            return minutosEsperando(b) - minutosEsperando(a);
        }

        return new Date(b.horaSalida || 0) - new Date(a.horaSalida || 0);
    });
}

/* ── NIVEL DE ALERTA CONTRA UNA META ──────────────────────

   La regla es la misma en toda la aplicación, venga la meta de
   donde venga: pasarse de ella enciende el amarillo, doblarla
   enciende el rojo. Está escrita UNA vez aquí para que la espera
   en patio y el tiempo en muelle no puedan interpretarse con
   criterios distintos.

   `umbrales` es el objeto { atencion, urgente } que ya arman
   `umbralesPatio()` y `tiemposDe()` en config.js — los dos
   devuelven esa misma forma, así que sirven indistintamente.

   Sin umbrales o con la meta en cero devuelve 'normal': una meta
   que nadie configuró no puede incumplirse, y pintar de rojo un
   vehículo por un dato que falta es una alarma falsa.
   ───────────────────────────────────────────────────────── */

export function nivelContraMeta(minutos, umbrales) {
    if (!umbrales || !umbrales.urgente) return 'normal';
    if (minutos >= umbrales.urgente) return 'alta';
    if (minutos >= umbrales.atencion) return 'media';
    return 'normal';
}

/* Umbrales de espera en patio con los que operaba el sistema
   cuando estaban fijos en el código. Se conservan como valor de
   partida para los paneles que todavía no pasan la configuración
   de su bodega — así ninguno se queda sin alerta mientras se
   migran uno por uno. */
export const UMBRALES_PATIO_POR_DEFECTO = { atencion: 120, urgente: 240 };

/*
    Nivel de urgencia por el tiempo de espera en patio.

    `umbrales` sale de umbralesPatio(config) — el límite de patio
    que el administrador configura por bodega. Antes eran 120/240
    fijos aquí, con un comentario prometiendo moverlos a la
    configuración; esto es ese movimiento. Sin argumento se
    comporta exactamente como antes.
*/
export function nivelPrioridad(minutos, umbrales) {
    return nivelContraMeta(minutos, umbrales || UMBRALES_PATIO_POR_DEFECTO);
}

/*
    En qué fase va el vehículo AHORA. Un "Ambos" descarga primero
    y carga después, y cada fase tiene su propia meta: preguntar
    por `tipo` devolvería "Ambos", que no es una fase sino las dos.
    `avanceTipo` es el que se mueve solo al terminar el descargue.
*/
export function faseActual(r) {
    return (r && (r.avanceTipo || r.tipo)) || '';
}

/*
    Minutos que el vehículo lleva EN MUELLE ahora mismo. Sale del
    historial y no de una resta contra la hora de entrada: un
    vehículo que esperó dos horas en patio antes de subir no lleva
    dos horas de muelle.

    Cero para el que ya salió o no está en muelle: no hay tiempo
    corriendo contra ninguna meta.
*/
export function minutosEnMuelle(r) {
    if (!r || r.horaSalida) return 0;
    if (r.ubicacion !== 'Muelle') return 0;
    return getLocationDurations(r).muelle || 0;
}


/* ── PRIORIDAD DE UN VEHÍCULO CONTRA SU PROPIA META ───────

   Un vehículo activo corre contra UN reloj y UNA meta, y cuáles
   son depende de dónde está parado:

       PATIO    el reloj es lo que lleva adentro y la meta es el
                límite de patio de la bodega — igual para todos,
                porque esperar es esperar.

       MUELLE   el reloj es lo que lleva EN MUELLE (no lo que
                lleva adentro: la espera previa en patio ya se
                contó allá) y la meta sale de su tipología y de
                la fase en la que va. Una MULA 40 arrumada no
                debería tardar lo mismo que una paletizada.

   De ahí salen las tres cifras con las que se ordena y se pinta:

       exceso    minutos POR ENCIMA de la meta (0 si va en hora)
       consumo   fracción de la meta ya gastada (0.8 = va en el
                 80% del tiempo que debería tardar)
       nivel     'normal' | 'media' | 'alta', la misma escala de
                 nivelContraMeta() que ya usa todo lo demás

   `meta` es SOLO la meta configurada: cero cuando el vehículo no
   tiene tipología asignada, y por eso `nivel` se queda en
   'normal' — no se puede incumplir una meta que nadie fijó, y
   pintar de rojo por un dato que falta es una alarma falsa.

   `referencia` sí puede traer la meta promedio de la bodega en
   ese caso (ver metaPromedioMuelle en config.js). Es lo que
   permite ORDENAR a un vehículo sin tipología sin mandarlo al
   final de la fila; `estimada` avisa que esa cifra no es suya.
   ───────────────────────────────────────────────────────── */

export function prioridadDe(r, config) {

    if (!r || r.horaSalida) {
        return {
            ubicacion: null, minutos: 0, umbrales: null,
            meta: 0, referencia: 0, estimada: false,
            exceso: 0, consumo: 0, nivel: 'normal'
        };
    }

    var enMuelle = r.ubicacion === 'Muelle';

    var minutos = enMuelle ? minutosEnMuelle(r) : minutosEsperando(r);

    var umbrales = enMuelle
        ? tiemposDe(config, r.tipologia, faseActual(r), modalidadDe(r))
        : (config ? umbralesPatio(config) : UMBRALES_PATIO_POR_DEFECTO);

    // umbralesTiempo() trae `meta` y umbralesPatio() trae `atencion`
    // con el límite; las dos son el mismo número: a partir de ahí se
    // está fuera de meta.
    var meta = umbrales ? (umbrales.meta || umbrales.atencion || 0) : 0;

    var referencia = meta;
    var estimada = false;

    if (!referencia && enMuelle) {
        referencia = metaPromedioMuelle(config);
        estimada = referencia > 0;
    }

    return {
        ubicacion: enMuelle ? 'Muelle' : 'Patio',
        minutos: minutos,
        umbrales: umbrales,
        meta: meta,
        referencia: referencia,
        estimada: estimada,
        exceso: referencia ? Math.max(0, minutos - referencia) : 0,
        consumo: referencia ? minutos / referencia : 0,
        nivel: nivelContraMeta(minutos, umbrales)
    };
}

/*
    Los vehículos que AHORA MISMO están en muelle y ya se pasaron
    de la meta que el administrador configuró para su tipología,
    del más retrasado al menos.

    Es la población de la alerta de muelle, y por eso exige `meta`
    y no `referencia`: la meta promedio de la bodega sirve para
    ordenar, pero disparar una alerta contra el promedio de otros
    vehículos sería avisar de un incumplimiento que nadie definió.

    No reemplaza a la alerta de patio: son dos relojes distintos y
    cada uno avisa de lo suyo.
*/
export function enMuelleFueraDeMeta(recs, config) {

    var conMeta = [];

    (recs || []).forEach(function (r) {
        if (!r || r.horaSalida || r.ubicacion !== 'Muelle') return;
        var p = prioridadDe(r, config);
        if (p.meta > 0 && p.nivel !== 'normal') conMeta.push({ rec: r, p: p });
    });

    conMeta.sort(function (a, b) { return b.p.exceso - a.p.exceso; });

    return conMeta.map(function (x) { return x.rec; });
}


/* ── ETIQUETAS DE HISTORIAL (para UI) ── */

export function iconoHistorial(tipo) {
    return tipo === 'entrada' ? 'ti-login'
        : tipo === 'salida' ? 'ti-logout'
        : tipo === 'operacion' ? 'ti-transfer-in'
        : tipo === 'canal' ? 'ti-route'
        : tipo === 'observacion' ? 'ti-message-2'
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

    if (item.tipo === 'observacion') {
        return 'Observación del operario';
    }

    if (item.tipo === 'avance') {
        return 'Avance de cargue/descargue actualizado';
    }

    if (item.tipo === 'autorizacion') {
        return 'Salida anticipada autorizada por el supervisor';
    }

    /* Corregir un registro es reescribir lo que pasó, así que el
       historial lo anuncia como lo que es. El detalle campo por
       campo —con el valor viejo y el nuevo— va en `texto`, que lo
       arma corregirRegistro() en vehiculos.js. */
    if (item.tipo === 'correccion') {
        return 'Datos del vehículo corregidos';
    }

    /* De cómo viene la mercancía cuelga la meta de tiempo en
       muelle, así que marcarla mueve la alerta en el acto. Queda
       en el historial por eso: es una decisión, no una nota. */
    if (item.tipo === 'modalidad') {
        return 'Modalidad de la mercancía marcada';
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