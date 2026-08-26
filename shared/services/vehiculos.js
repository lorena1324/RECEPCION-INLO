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

const COLECCION = "vehiculos";


/* =========================================================
   CREAR REGISTRO (entrada de vehículo)

   `datos` trae los mismos campos que ya arma registrarEntrada()
   en bodega-J4.html (conductor, placa, hora, ubicacion,
   numeroMuelle, bahia, canal, tipo, programado, etc.)
   ========================================================= */

export async function crearRegistro(operacion, datos, operador) {

    const destinoCompleto = datos.destino;

    const rec = {
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
    };

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
        fecha: new Date().toISOString().slice(0, 16),
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