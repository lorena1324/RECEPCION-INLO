/* =========================================================
   INLOTRANS
   Servicio de vehículos (Firestore)

   Migrado de la lógica _fbSave/_fbDelete de Realtime Database
   en bodega-J4.html. Mismo modelo de datos, mismo comportamiento,
   pero:
     - Ahora es Firestore, no Realtime Database.
     - Una sola colección "vehiculos" compartida por todas las
       operaciones (campo `operacion`: "J3" | "J4" | "B9"), en
       vez de árboles separados porteria/ y porteria_j4/ — así
       el panel de administrador (Fase 5) puede comparar
       operaciones sin duplicar lógica.
     - Ya no hay modo local con localStorage como respaldo
       silencioso: si Firestore falla, se avisa con un error
       real (punto 22 del prompt maestro: "no perder datos
       silenciosamente" — el modo offline real con IndexedDB
       se aborda aparte, más adelante).
   ========================================================= */

import {
    collection,
    doc,
    addDoc,
    updateDoc,
    deleteDoc,
    query,
    where,
    onSnapshot,
    arrayUnion,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { db } from "../core/firebase.js";
import { getDestino, ordenarPorPrioridad } from "../services/eventos.js";
import { nowLocal } from "../utils/tiempos.js";

const COLECCION = "vehiculos";


/* =========================================================
   FASES DE UN VEHÍCULO

   Un vehículo "Ambos" hace dos fases en orden fijo: primero
   descarga y después carga. Los de un solo tipo hacen una sola.
   Se usa para saber cuántos juegos de picking/auditoría lleva
   el registro — uno por fase, porque no se puede alistar ni
   auditar lo que se va a cargar antes de haber descargado.
   ========================================================= */

export function fasesDe(tipo) {
    if (tipo === "Ambos") return ["Descargue", "Cargue"];
    return tipo ? [tipo] : [];
}


/* =========================================================
   CREAR REGISTRO (entrada de vehículo)

   `datos` trae los mismos campos que ya arma registrarEntrada()
   en bodega-J4.html (conductor, placa, hora, ubicacion,
   numeroMuelle, bahia, canal, tipo, programado, etc.)
   ========================================================= */

export async function crearRegistro(operacion, datos, operador) {

    const destinoCompleto = datos.destino;

    // Picking y auditoría se llevan POR FASE, no por vehículo: un
    // vehículo "Ambos" alista y audita lo que descarga, y después
    // alista y audita lo que carga. Se inicializan en 0 solo las
    // fases que el vehículo realmente va a hacer.
    const etapas = {};
    fasesDe(datos.tipo).forEach(function (fase) {
        etapas["picking" + fase] = 0;
        etapas["auditoria" + fase] = 0;
    });

    const rec = Object.assign(etapas, {
        operacion: operacion,

        conductor: datos.conductor || "",
        placa: datos.placa,

        horaEntrada: datos.horaEntrada,
        programado: datos.programado === "Programado",
        horaProgramacion: datos.horaProgramacion || "",

        ubicacion: datos.ubicacion,
        numeroMuelle: datos.numeroMuelle || "",
        bahia: datos.bahia || "A",
        canal: datos.canal,

        destino: destinoCompleto,

        tipo: datos.tipo,

        // Avance de cargue/descargue: si el tipo ya es uno solo, el
        // "avanceTipo" queda fijo desde la entrada. Si es "Ambos", el
        // vehículo siempre arranca en Descargue — es un orden fijo del
        // negocio, no algo que el supervisor deba elegir — y al llegar
        // al 100% pasa automáticamente a Cargue (ver incrementarAvance()
        // en supervisor.js).
        avanceTipo: datos.tipo === "Ambos" ? "Descargue" : datos.tipo,
        avancePorcentaje: 0,

        cedula: datos.cedula || "",
        obs: datos.obs || "",

        servicioTipo: datos.servicioTipo || "Normal",
        servicioEmpresa: datos.servicioEmpresa || "",

        horaSalida: null,
        obsSalida: "",

        fecha: datos.horaEntrada.slice(0, 10),

        operadorEntrada: operador,
        operadorSalida: null,

        historial: [{
            fecha: datos.horaEntrada,
            tipo: "entrada",
            operador: operador,
            ubicacion: destinoCompleto,
            texto: datos.obs || ""
        }],

        creadoEn: serverTimestamp()
    });

    const ref = await addDoc(collection(db, COLECCION), rec);

    return ref.id;
}


/* =========================================================
   SUSCRIBIRSE A REGISTROS DE UNA OPERACIÓN (tiempo real)

   Reemplaza el onValue() de Realtime Database. Devuelve una
   función `unsubscribe` — llámala cuando la página se
   desmonte/cambie de vista para no dejar listeners activos.
   ========================================================= */

export function suscribirseARegistros(operacion, callback) {

    const q = query(
        collection(db, COLECCION),
        where("operacion", "==", operacion)
    );

    return onSnapshot(q, function (snapshot) {

        const registros = [];

        snapshot.forEach(function (docSnap) {
            registros.push(Object.assign({ id: docSnap.id }, docSnap.data()));
        });

        registros.sort(function (a, b) {
            return new Date(b.horaEntrada) - new Date(a.horaEntrada);
        });

        callback(registros);

    }, function (error) {
        console.error("Error al escuchar registros:", error);
        callback(null, error);
    });
}


/* =========================================================
   ACTUALIZAR UBICACIÓN (Patio → Muelle, sin crear registro nuevo)
   ========================================================= */

export async function actualizarUbicacion(id, cambios, operador) {

    const entrada = {
        fecha: nowLocal(),
        tipo: "ubicacion",
        operador: operador,
        ubicacion: cambios.destino,
        ubicacionAnterior: cambios.ubicacionAnterior || "",
        texto: cambios.obsUbicacion || ""
    };

    const cambiosDoc = {
        ubicacion: cambios.ubicacion,
        numeroMuelle: cambios.numeroMuelle || "",
        bahia: cambios.bahia || "A",
        destino: cambios.destino,
        obsUbicacion: cambios.obsUbicacion || "",
        historial: arrayUnion(entrada)
    };

    if (cambios.canal) {
        cambiosDoc.canal = cambios.canal;
    }

    await updateDoc(doc(db, COLECCION, id), cambiosDoc);
}


/* =========================================================
   AGREGAR LA OPERACIÓN QUE LE FALTABA (Cargue o Descargue → Ambos)

   El operario detecta en muelle que un vehículo que solo iba a
   hacer una operación en realidad necesita las dos, y lo marca
   aquí como "Ambos". `rec` es el registro actual en memoria del
   llamador (para saber en qué fase de avance está y no perder
   nada al reordenar):

     - Si ya estaba en fase Descargue, no se toca — es el orden
       correcto (descargue siempre va primero) y sigue igual.
     - Si estaba en fase Cargue sin avance (0%) o no tenía fase
       todavía (vehículo de antes de esta función), se reinicia
       en Descargue — no hay nada que perder.
     - Si ya estaba en fase Cargue CON avance, ese % se guarda en
       `avanceCarguePendiente` para retomarlo automáticamente en
       cuanto termine el descargue (ver avanzarAFaseCargue en
       supervisor.js) — no se pierde el trabajo ya hecho.
   ========================================================= */

export async function agregarOperacionFaltante(id, rec, operador) {

    if (rec.tipo === "Ambos") return;

    const faltante = rec.tipo === "Cargue" ? "Descargue" : "Cargue";

    const entrada = {
        fecha: nowLocal(),
        tipo: "operacion",
        operador: operador,
        tipoAnterior: rec.tipo,
        tipoNuevo: "Ambos",
        texto: `Se agregó ${faltante} — el vehículo ya venía haciendo ${rec.tipo}`
    };

    const cambiosDoc = {
        tipo: "Ambos",
        historial: arrayUnion(entrada)
    };

    if (rec.avanceTipo !== "Descargue") {
        cambiosDoc.avanceTipo = "Descargue";
        cambiosDoc.avancePorcentaje = 0;

        if (rec.avanceTipo === "Cargue" && (rec.avancePorcentaje || 0) > 0) {
            cambiosDoc.avanceCarguePendiente = rec.avancePorcentaje;
        }
    }

    await updateDoc(doc(db, COLECCION, id), cambiosDoc);
}


/* =========================================================
   REGISTRAR SALIDA (despacho)
   ========================================================= */

export async function registrarSalida(id, horaSalida, obsSalida, operador) {

    const entrada = {
        fecha: horaSalida,
        tipo: "salida",
        operador: operador,
        texto: obsSalida || ""
    };

    await updateDoc(doc(db, COLECCION, id), {
        horaSalida: horaSalida,
        obsSalida: obsSalida || "",
        operadorSalida: operador,
        historial: arrayUnion(entrada)
    });
}


/* =========================================================
   ACTUALIZAR AVANCE (porcentaje de cargue/descargue)

   `cambios.avanceTipo` fija cuál de los dos está midiendo el
   supervisor (obligatorio elegirlo una vez cuando `tipo` es
   "Ambos"). El porcentaje siempre se guarda entre 0 y 100 —
   nunca puede pasarse de 100 aunque el llamador lo intente.
   ========================================================= */

export async function actualizarAvance(id, cambios, operador) {

    const porcentaje = Math.max(0, Math.min(100, Math.round(cambios.porcentaje)));

    const entrada = {
        fecha: nowLocal(),
        tipo: "avance",
        operador: operador,
        texto: `Avance de ${cambios.avanceTipo} actualizado a ${porcentaje}%`
    };

    await updateDoc(doc(db, COLECCION, id), {
        avanceTipo: cambios.avanceTipo,
        avancePorcentaje: porcentaje,
        historial: arrayUnion(entrada)
    });
}


/* =========================================================
   AVANZAR A LA FASE DE CARGUE (cuando el descargue llega al 100%)

   Solo aplica a vehículos "Ambos": el descargue siempre va
   primero, y al completarse se pasa solo a Cargue. Normalmente
   arranca en 0%, salvo que el vehículo ya traía cargue pendiente
   de antes de agregarle el descargue (ver agregarOperacionFaltante)
   — en ese caso retoma exactamente donde se había quedado.
   ========================================================= */

export async function avanzarAFaseCargue(id, cambios, operador) {

    const entrada = {
        fecha: nowLocal(),
        tipo: "avance",
        operador: operador,
        texto: `Descargue completado — inicia Cargue en ${cambios.porcentajeInicial}%`
    };

    await updateDoc(doc(db, COLECCION, id), {
        avanceTipo: "Cargue",
        avancePorcentaje: cambios.porcentajeInicial,
        historial: arrayUnion(entrada)
    });
}


/* =========================================================
   AUTORIZAR SALIDA ANTICIPADA (solo Cargue, mínimo 75%)

   Un supervisor autoriza que un vehículo salga sin haber
   llegado al 100% de cargue, dejando constancia del motivo en
   el historial. `cambios.porcentaje` es el % que tenía el
   vehículo al momento de autorizar (lo trae el llamador, que ya
   tiene el registro en memoria) — se guarda como referencia,
   no se vuelve a validar aquí contra el servidor.
   ========================================================= */

export async function autorizarSalidaAnticipada(id, cambios, supervisor) {

    const entrada = {
        fecha: nowLocal(),
        tipo: "autorizacion",
        operador: supervisor,
        texto: cambios.motivo
    };

    await updateDoc(doc(db, COLECCION, id), {
        autorizacionSalida: {
            autorizadoPor: supervisor,
            motivo: cambios.motivo,
            fecha: nowLocal(),
            porcentajeAlAutorizar: cambios.porcentaje
        },
        historial: arrayUnion(entrada)
    });
}


/* =========================================================
   ELIMINAR REGISTRO
   ========================================================= */

export async function eliminarRegistro(id) {
    await deleteDoc(doc(db, COLECCION, id));
}


/* =========================================================
   MUELLES — ocupación y disponibilidad

   Funciones puras (sin Firestore, sin DOM): reciben la lista
   de registros ya cargada y calculan qué muelles están libres.
   La parte de "pintar el <select>" se queda en la página
   (operador.js), aquí solo se calcula el dato.
   ========================================================= */

export function getMuellesOcupacion(registrosActivosEnMuelle, numMuelles) {

    const ocupacion = {};

    for (let n = 1; n <= numMuelles; n++) {
        ocupacion[n] = registrosActivosEnMuelle.find(function (r) {
            return String(r.numeroMuelle) === String(n);
        }) || null;
    }

    return ocupacion;
}

export function getMuellesLibres(ocupacion, numMuelles, muelleActual) {

    const libres = [];

    for (let n = 1; n <= numMuelles; n++) {
        const ocupante = ocupacion[n];
        const esElActual = muelleActual != null && String(n) === String(muelleActual);

        if (!ocupante || esElActual) {
            libres.push(n);
        }
    }

    return libres;
}


/* =========================================================
   FILTROS DE VISTA (dashboard / grilla de muelles)
   ========================================================= */

export function getRegistrosEnPatio(registros) {
    const enPatio = registros.filter(function (r) {
        return !r.horaSalida && r.ubicacion !== "Muelle" && (r.destino || "").indexOf("Muelle") !== 0;
    });
    return ordenarPorPrioridad(enPatio);
}

export function getRegistrosEnMuelle(registros) {
    return registros.filter(function (r) {
        return !r.horaSalida && (r.ubicacion === "Muelle" || (r.destino || "").indexOf("Muelle") === 0);
    });
}

export function puedeDespachar(r) {
    if (!r) return false;
    return r.ubicacion === "Muelle" || (r.destino || "").indexOf("Muelle") === 0 || (r.destino || "").indexOf("Muelle") !== -1;
}


/* =========================================================
   REGLA: NO SALIR SIN COMPLETAR EL AVANCE (cargue/descargue)

   `avancePorcentaje` no existía antes de esta función — los
   vehículos que ya estaban activos en el sistema cuando se
   agregó nunca lo tendrán en su documento (undefined), así que
   quedan exceptuados de la regla automáticamente: no es justo
   bloquearlos por un dato que nunca se les pidió. Solo los
   registros creados de aquí en adelante (que sí traen el campo,
   aunque sea en 0) quedan sujetos a ella.

   Reglas de negocio (definidas por el cliente):
     - Descargue: sin excepción, debe llegar al 100% para salir.
       Ni el operario ni el supervisor pueden saltarse esto.
     - Cargue: puede salir por debajo del 100% SOLO si (a) llegó
       al menos al 75% y (b) un supervisor autorizó la salida
       explicando el motivo (autorizarSalidaAnticipada). Por
       debajo del 75% no hay ninguna excepción posible.
     - Un vehículo "Ambos" sin que el supervisor haya elegido
       todavía cuál de los dos está midiendo (avanceTipo null)
       se trata como Descargue: 100% sin excepción, porque no
       hay forma de saber si aplica la excepción de Cargue.
   ========================================================= */

export function requiereAvanceCompleto(r) {
    return r.avancePorcentaje !== undefined && r.avancePorcentaje !== null;
}

export function avanceCompleto(r) {
    return (r.avancePorcentaje || 0) >= 100;
}

export function puedeAutorizarSalidaAnticipada(r) {
    if (!requiereAvanceCompleto(r)) return false;
    if (avanceCompleto(r)) return false;
    if (r.avanceTipo !== "Cargue") return false;
    return (r.avancePorcentaje || 0) >= 75;
}

export function puedeRegistrarSalida(r) {
    if (!requiereAvanceCompleto(r)) return true;
    if (avanceCompleto(r)) return true;
    if (r.avanceTipo !== "Cargue") return false;
    if ((r.avancePorcentaje || 0) < 75) return false;
    return !!(r.autorizacionSalida && r.autorizacionSalida.motivo);
}

/* =========================================================
   DIAGNÓSTICO DE SALIDA (por qué NO puede salir, y qué falta)

   Las funciones de arriba responden sí/no. Esta responde
   "por qué" y, sobre todo, "cuánto falta" — que es lo que el
   operario necesita ver en portería para saber si espera o
   llama al supervisor, sin poder tocar el avance él mismo.

   Devuelve siempre el mismo objeto, así que quien lo pinta no
   tiene que repetir la lógica de negocio:

     puedeSalir  boolean  — equivalente a puedeRegistrarSalida()
     nivel       'ok' | 'sin-avance' | 'bloqueo' | 'espera'
     titulo      resumen corto (una línea, para badges/estados)
     detalle     frase completa para la alerta del modal
     accion      qué hay que hacer para desbloquearlo
     porcentaje  avance actual
     minimo      % mínimo que exige la regla que está fallando
     faltante    puntos que faltan para ese mínimo (0 si ninguno)

   `minimo`/`faltante` van en null cuando el bloqueo no se
   resuelve subiendo el porcentaje (p. ej. ya está en el 75% y
   lo único que falta es la firma del supervisor).
   ========================================================= */

export const MINIMO_CARGUE_ANTICIPADO = 75;
export const MINIMO_SALIDA = 100;

export function diagnosticoSalida(r) {

    if (!r) {
        return {
            puedeSalir: false, nivel: 'bloqueo',
            titulo: 'Registro no encontrado',
            detalle: 'No se encontró el registro del vehículo.',
            accion: 'Recarga la página e inténtalo de nuevo.',
            porcentaje: 0, minimo: null, faltante: null
        };
    }

    var pct = r.avancePorcentaje || 0;
    var esCargue = r.avanceTipo === 'Cargue';
    var tipo = r.avanceTipo || r.tipo || 'la operación';

    // Registros anteriores a la función de avance: nunca se les
    // pidió el dato, así que no se les puede exigir.
    if (!requiereAvanceCompleto(r)) {
        return {
            puedeSalir: true, nivel: 'sin-avance',
            titulo: 'Sin avance registrado',
            detalle: 'Este vehículo no tiene avance de cargue/descargue registrado (es un registro anterior a esta función), así que puede salir sin restricción de porcentaje.',
            accion: 'Verifica manualmente con el muelle antes de confirmar la salida.',
            porcentaje: 0, minimo: null, faltante: null
        };
    }

    if (avanceCompleto(r)) {
        return {
            puedeSalir: true, nivel: 'ok',
            titulo: 'Completo — listo para salir',
            detalle: 'El ' + tipo.toLowerCase() + ' está al 100%. El vehículo puede salir.',
            accion: '',
            porcentaje: pct, minimo: MINIMO_SALIDA, faltante: 0
        };
    }

    var autorizada = !!(r.autorizacionSalida && r.autorizacionSalida.motivo);

    if (esCargue && pct >= MINIMO_CARGUE_ANTICIPADO && autorizada) {
        return {
            puedeSalir: true, nivel: 'ok',
            titulo: 'Salida anticipada autorizada',
            detalle: 'El cargue está en ' + pct + '%, pero un supervisor autorizó la salida anticipada' +
                     (r.autorizacionSalida.autorizadoPor ? ' (' + r.autorizacionSalida.autorizadoPor + ')' : '') + '.',
            accion: '',
            porcentaje: pct, minimo: MINIMO_CARGUE_ANTICIPADO, faltante: 0
        };
    }

    // Descargue (y "Ambos" sin fase definida): 100% sin excepción.
    if (!esCargue) {
        return {
            puedeSalir: false, nivel: 'bloqueo',
            titulo: 'El descargue debe llegar al 100%',
            detalle: 'El descargue está en ' + pct + '% y debe llegar al ' + MINIMO_SALIDA + '% para poder salir. No hay excepción posible: ni el operario ni el supervisor pueden saltarse esta regla.',
            accion: 'Faltan ' + (MINIMO_SALIDA - pct) + ' puntos de descargue. Espera a que el muelle lo complete.',
            porcentaje: pct, minimo: MINIMO_SALIDA, faltante: MINIMO_SALIDA - pct
        };
    }

    // Cargue por debajo del 75%: ni siquiera es autorizable.
    if (pct < MINIMO_CARGUE_ANTICIPADO) {
        return {
            puedeSalir: false, nivel: 'bloqueo',
            titulo: 'El cargue no llega al mínimo autorizable',
            detalle: 'El cargue está en ' + pct + '% y debe llegar mínimo al ' + MINIMO_CARGUE_ANTICIPADO + '% para que un supervisor siquiera pueda autorizar una salida anticipada.',
            accion: 'Faltan ' + (MINIMO_CARGUE_ANTICIPADO - pct) + ' puntos para el mínimo del ' + MINIMO_CARGUE_ANTICIPADO + '%, o ' + (MINIMO_SALIDA - pct) + ' para completar el cargue y salir sin autorización.',
            porcentaje: pct, minimo: MINIMO_CARGUE_ANTICIPADO, faltante: MINIMO_CARGUE_ANTICIPADO - pct
        };
    }

    // Cargue entre 75% y 99%: solo falta la firma del supervisor.
    return {
        puedeSalir: false, nivel: 'espera',
        titulo: 'Falta la autorización del supervisor',
        detalle: 'El cargue está en ' + pct + '% (ya pasó el mínimo del ' + MINIMO_CARGUE_ANTICIPADO + '%), pero por debajo del 100% un supervisor debe autorizar la salida anticipada indicando el motivo.',
        accion: 'Pídele al supervisor que autorice la salida, o espera los ' + (MINIMO_SALIDA - pct) + ' puntos que faltan para el 100%.',
        porcentaje: pct, minimo: null, faltante: null
    };
}
