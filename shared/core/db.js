/* =========================================================
   INLOTRANS
   Base de datos: la API de Firestore, encima de Supabase

   Los servicios (vehiculos.js, config.js, cobros.js…) se
   escribieron para Firestore. En vez de reescribirlos, este
   archivo ofrece las MISMAS funciones que usaban —doc,
   collection, getDoc, getDocs, setDoc, updateDoc, addDoc,
   deleteDoc, query, where, onSnapshot, runTransaction,
   arrayUnion, serverTimestamp— pero guardando en Supabase
   (tablas de supabase/esquema.sql).

   Cómo se traduce:
     - Cada colección es una tabla { id, datos (jsonb), version }.
     - LEER va directo a la tabla (las reglas RLS filtran).
     - ESCRIBIR va SIEMPRE por la función aplicar_escrituras(),
       que revisa los permisos (antes firestore.rules) y aplica
       todo o nada.
     - runTransaction es optimista, como en Firestore: anota la
       versión de lo que leyó; si al confirmar algo cambió, el
       servidor responde CONFLICTO y se reintenta desde cero.
     - onSnapshot usa Supabase Realtime.
   ========================================================= */

import { supabase } from "./supabase.js";

export { supabase };

// Marcador que los servicios pasan como primer argumento (`db`).
export const db = { tipo: "db" };

const COLECCIONES = {
    vehiculos: "vehiculos",
    cobros: "cobros",
    placasActivas: "placas_activas",
    config: "config"
};

const INTENTOS_TRANSACCION = 5;


/* =========================================================
   ERRORES

   Se traducen a los mismos `code` que daba Firestore, porque
   las pantallas preguntan por ellos (p. ej. "permission-denied").
   ========================================================= */

class ErrorBaseDatos extends Error {
    constructor(code, message, causa) {
        super(message);
        this.name = "ErrorBaseDatos";
        this.code = code;
        this.causa = causa;
    }
}

function traducirError(error) {
    const texto = (error && error.message) || String(error);

    if (texto.includes("CONFLICTO")) return new ErrorBaseDatos("aborted", "La información cambió mientras se guardaba.", error);
    if (texto.includes("PERMISO_DENEGADO") || error?.code === "42501") {
        return new ErrorBaseDatos("permission-denied", "Missing or insufficient permissions.", error);
    }
    if (texto.includes("NO_EXISTE")) return new ErrorBaseDatos("not-found", "No document to update.", error);
    if (texto.includes("Failed to fetch") || texto.includes("NetworkError")) {
        return new ErrorBaseDatos("unavailable", "No hay conexión con la base de datos.", error);
    }
    return new ErrorBaseDatos("unknown", texto, error);
}


/* =========================================================
   REFERENCIAS
   ========================================================= */

function ubicar(segmentos) {

    // config/{operacion}/privado → tabla config_privado, id "{operacion}/{documento}"
    if (segmentos[0] === "config" && segmentos[2] === "privado") {
        return { tabla: "config_privado", prefijo: segmentos[1] + "/" };
    }

    const tabla = COLECCIONES[segmentos[0]];
    if (!tabla || segmentos.length !== 1) {
        throw new Error("Colección no soportada en Supabase: " + segmentos.join("/"));
    }
    return { tabla, prefijo: "" };
}

function idAutomatico() {
    const letras = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const azar = crypto.getRandomValues(new Uint8Array(20));
    return Array.from(azar, (n) => letras[n % letras.length]).join("");
}

export function collection(_db, ...segmentos) {
    const { tabla, prefijo } = ubicar(segmentos);
    return { tipo: "col", segmentos, tabla, prefijo, filtros: [] };
}

function refDoc(col, id) {
    return {
        tipo: "doc",
        id,
        tabla: col.tabla,
        idFila: col.prefijo + id,
        path: col.segmentos.join("/") + "/" + id
    };
}

// doc(colección) → id nuevo · doc(colección, id) · doc(db, "col", id[, "sub", id])
export function doc(base, ...segmentos) {

    if (base && base.tipo === "col") {
        return refDoc(base, segmentos.length ? segmentos[0] : idAutomatico());
    }

    const id = segmentos.pop();
    return refDoc(collection(db, ...segmentos), id);
}


/* =========================================================
   CONSULTAS
   ========================================================= */

export function where(campo, operador, valor) {
    if (operador !== "==") throw new Error("Solo se soporta where(campo, \"==\", valor)");
    return { campo, valor };
}

export function query(col, ...filtros) {
    return { ...col, tipo: "consulta", filtros: col.filtros.concat(filtros) };
}

function aplicarFiltros(consulta, filtros) {
    for (const f of filtros) {
        const columna = "datos->>" + f.campo;
        consulta = f.valor === null || f.valor === undefined
            ? consulta.is(columna, null)
            : consulta.eq(columna, String(f.valor));
    }
    return consulta;
}

function cumpleFiltros(datos, filtros) {
    return filtros.every(function (f) {
        const v = datos ? datos[f.campo] : undefined;
        if (f.valor === null || f.valor === undefined) return v === null || v === undefined;
        return v === f.valor;
    });
}


/* =========================================================
   INSTANTÁNEAS (lo que devolvía Firestore al leer)
   ========================================================= */

function instantanea(ref, fila) {
    return {
        id: ref.id,
        ref,
        version: fila ? fila.version : null,
        exists: () => !!fila,
        data: () => (fila ? fila.datos : undefined)
    };
}

function instantaneaConsulta(col, filas) {
    const docs = filas.map((fila) => instantanea(refDoc(col, fila.id.slice(col.prefijo.length)), fila));
    return {
        docs,
        size: docs.length,
        empty: docs.length === 0,
        forEach: (fn) => docs.forEach(fn)
    };
}


/* =========================================================
   LEER
   ========================================================= */

async function leerFila(ref) {
    const { data, error } = await supabase
        .from(ref.tabla)
        .select("id, datos, version")
        .eq("id", ref.idFila)
        .maybeSingle();

    if (error) throw traducirError(error);
    return data;
}

export async function getDoc(ref) {

    const fila = await leerFila(ref);

    // Firestore negaba la lectura de las tarifas con permission-denied; aquí RLS
    // solo devuelve "nada", así que se pregunta aparte para distinguir los casos.
    if (!fila && ref.tabla === "config_privado") {
        const { data: puede, error } = await supabase.rpc("puede_leer_privado", { op: ref.idFila.split("/")[0] });
        if (error) throw traducirError(error);
        if (!puede) throw new ErrorBaseDatos("permission-denied", "Missing or insufficient permissions.");
    }

    return instantanea(ref, fila);
}

// Supabase entrega máximo 1000 filas por petición: se pide por páginas.
async function leerFilas(col) {

    const PAGINA = 1000;
    const filas = [];

    for (let desde = 0; ; desde += PAGINA) {

        let consulta = supabase.from(col.tabla).select("id, datos, version");
        if (col.prefijo) consulta = consulta.like("id", col.prefijo + "%");
        consulta = aplicarFiltros(consulta, col.filtros).order("id").range(desde, desde + PAGINA - 1);

        const { data, error } = await consulta;
        if (error) throw traducirError(error);

        filas.push(...data);
        if (data.length < PAGINA) return filas;
    }
}

export async function getDocs(col) {
    return instantaneaConsulta(col, await leerFilas(col));
}


/* =========================================================
   ESCRIBIR
   ========================================================= */

export function arrayUnion(...valores) {
    return { __op: "arrayUnion", valores };
}

export function serverTimestamp() {
    return { __op: "serverTimestamp" };
}

export function deleteField() {
    return { __op: "deleteField" };
}

function escritura(tipo, ref, datos, merge) {
    // JSON.parse(JSON.stringify()) quita los `undefined`, como hacía Firestore al guardar.
    return {
        tipo,
        tabla: ref.tabla,
        id: ref.idFila,
        datos: datos === undefined ? null : JSON.parse(JSON.stringify(datos)),
        merge: !!merge
    };
}

async function confirmar(lecturas, escrituras) {
    const { error } = await supabase.rpc("aplicar_escrituras", { lecturas, escrituras });
    if (error) throw traducirError(error);
}

export async function setDoc(ref, datos, opciones) {
    await confirmar([], [escritura("set", ref, datos, opciones && opciones.merge)]);
}

export async function updateDoc(ref, cambios) {
    await confirmar([], [escritura("update", ref, cambios)]);
}

export async function addDoc(col, datos) {
    const ref = doc(col);
    await setDoc(ref, datos);
    return ref;
}

export async function deleteDoc(ref) {
    await confirmar([], [escritura("delete", ref)]);
}


/* =========================================================
   TRANSACCIONES
   ========================================================= */

export async function runTransaction(_db, fn) {

    for (let intento = 1; ; intento++) {

        const lecturas = new Map();     // idFila de cada tabla → versión leída
        const escrituras = [];

        const tx = {
            async get(ref) {
                if (escrituras.length) throw new Error("En una transacción, todas las lecturas van antes de las escrituras.");
                const snap = instantanea(ref, await leerFila(ref));
                lecturas.set(ref.tabla + "|" + ref.idFila, { tabla: ref.tabla, id: ref.idFila, version: snap.version });
                return snap;
            },
            set(ref, datos, opciones) { escrituras.push(escritura("set", ref, datos, opciones && opciones.merge)); return tx; },
            update(ref, cambios) { escrituras.push(escritura("update", ref, cambios)); return tx; },
            delete(ref) { escrituras.push(escritura("delete", ref)); return tx; }
        };

        const resultado = await fn(tx);

        try {
            if (escrituras.length) await confirmar(Array.from(lecturas.values()), escrituras);
            return resultado;

        } catch (error) {
            if (error.code !== "aborted" || intento >= INTENTOS_TRANSACCION) throw error;
            await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * intento));
        }
    }
}


/* =========================================================
   TIEMPO REAL (onSnapshot)

   1. Se abre el canal de Realtime de la tabla.
   2. Se lee todo lo que pide la consulta, y otra vez cada vez que
      el canal (re)conecta, por si se perdió algo mientras tanto.
   3. Cada cambio que llega se aplica a la copia local y se avisa.
   ========================================================= */

let canales = 0;

export function onSnapshot(objetivo, alCambiar, alFallar) {

    const esDoc = objetivo.tipo === "doc";
    const col = esDoc ? null : objetivo;
    const filtros = esDoc ? [] : objetivo.filtros;

    const filas = new Map();            // idFila → { id, datos, version }
    let activo = true;
    let aviso = null;

    function emitir() {
        if (aviso) return;
        // Varias filas cambian en la misma transacción: se avisa una sola vez.
        aviso = setTimeout(function () {
            aviso = null;
            if (!activo) return;
            if (esDoc) {
                alCambiar(instantanea(objetivo, filas.get(objetivo.idFila) || null));
            } else {
                const lista = Array.from(filas.values()).filter((f) => f.id.startsWith(col.prefijo));
                alCambiar(instantaneaConsulta(col, lista));
            }
        }, 30);
    }

    function aplicar(fila) {
        const pertenece = esDoc ? fila.id === objetivo.idFila : fila.id.startsWith(col.prefijo) && cumpleFiltros(fila.datos, filtros);
        const actual = filas.get(fila.id);
        if (actual && actual.version > fila.version) return;
        if (pertenece) filas.set(fila.id, fila);
        else if (actual) filas.delete(fila.id);
        emitir();
    }

    async function cargarTodo() {
        try {
            const nuevas = esDoc ? [await leerFila(objetivo)].filter(Boolean) : await leerFilas(col);
            const vistas = new Set();
            for (const f of nuevas) {
                vistas.add(f.id);
                const actual = filas.get(f.id);
                if (!actual || actual.version <= f.version) filas.set(f.id, f);
            }
            for (const id of Array.from(filas.keys())) if (!vistas.has(id)) filas.delete(id);
            emitir();
        } catch (error) {
            if (activo && alFallar) alFallar(error);
        }
    }

    // Realtime filtra por UNA columna: la operación si la consulta la trae, o el id del documento.
    const porOperacion = filtros.find((f) => f.campo === "operacion");
    const filtro = esDoc
        ? "id=eq." + objetivo.idFila
        : porOperacion ? "operacion=eq." + porOperacion.valor : undefined;

    // Se lee de una vez, sin esperar al canal: si Realtime tarda o falla,
    // la pantalla igual muestra los datos (solo que sin actualizarse sola).
    cargarTodo();

    const canal = supabase.channel("inlo-" + objetivo.tabla + "-" + (++canales));

    canal
        .on("postgres_changes", { event: "INSERT", schema: "public", table: objetivo.tabla, filter: filtro },
            (p) => aplicar(p.new))
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: objetivo.tabla, filter: filtro },
            (p) => aplicar(p.new))
        // Los borrados no se pueden filtrar en Realtime: llegan todos y solo traen el id.
        .on("postgres_changes", { event: "DELETE", schema: "public", table: objetivo.tabla },
            (p) => { if (p.old && filas.delete(p.old.id)) emitir(); })
        .subscribe(function (estado, error) {
            if (!activo) return;
            if (estado === "SUBSCRIBED") cargarTodo();
            if (estado === "CHANNEL_ERROR" || estado === "TIMED_OUT") {
                console.warn("Tiempo real de " + objetivo.tabla + ": " + estado + " (se reintenta solo)", error || "");
            }
        });

    return function dejarDeEscuchar() {
        activo = false;
        clearTimeout(aviso);
        supabase.removeChannel(canal);
    };
}
