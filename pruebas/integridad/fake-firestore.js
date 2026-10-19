/* =========================================================
   Firestore FALSO, en memoria, para probar vehiculos.js de verdad

   No hay emulador de Firestore en esta máquina (ni Firebase CLI ni
   Java), así que este archivo reemplaza al SDK (por un importmap, ver
   index.html) con una versión en memoria que se comporta como lo que
   importa para estas pruebas:

     - Las TRANSACCIONES son optimistas, como las reales: si alguno de
       los documentos que leyeron cambió antes de confirmar, se
       reintentan desde cero. Todas las lecturas y escrituras esperan
       unos milisegundos al azar, para que dos usuarios "a la vez" se
       entrelacen de verdad en vez de ejecutarse uno tras otro.
     - arrayUnion no repite un elemento idéntico; serverTimestamp pone
       la hora.
     - Una lectura después de una escritura dentro de la transacción
       falla, igual que en Firestore.

   NO simula las reglas de seguridad (firestore.rules): eso solo se
   prueba en el Rules Playground o con el emulador.
   ========================================================= */

const almacen = new Map();       // "coleccion/id" → { datos, version }
let secuencia = 0;
export const registro = { transaccionesReintentadas: 0, reintentosMaximos: 0 };

const espera = () => new Promise((r) => setTimeout(r, 1 + Math.random() * 5));
const copia = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

/* ── referencias ── */

export function collection(_db, col) { return { tipo: "col", col }; }

export function doc(a, b, c) {
    if (a && a.tipo === "col") {                                    // doc(colección): id automático
        const id = "auto" + (++secuencia).toString(36) + Math.random().toString(36).slice(2, 6);
        return { tipo: "doc", col: a.col, id, path: a.col + "/" + id };
    }
    return { tipo: "doc", col: b, id: c, path: b + "/" + c };
}

export function where(campo, op, valor) { return { campo, op, valor }; }
export function query(col, ...filtros) { return { tipo: "query", col: col.col, filtros }; }

export const arrayUnion = (...items) => ({ __op: "union", items });
export const serverTimestamp = () => ({ __op: "ts" });

/* ── aplicar un parche con los centinelas ── */

function aplicar(actual, parche) {
    const nuevo = copia(actual) || {};
    for (const [k, v] of Object.entries(parche)) {
        if (v && v.__op === "union") {
            const previo = Array.isArray(nuevo[k]) ? nuevo[k] : [];
            for (const it of v.items) if (!previo.some((p) => JSON.stringify(p) === JSON.stringify(it))) previo.push(copia(it));
            nuevo[k] = previo;
        } else if (v && v.__op === "ts") {
            nuevo[k] = new Date().toISOString();
        } else {
            nuevo[k] = copia(v);
        }
    }
    return nuevo;
}

const instantanea = (ref, entrada) => ({
    id: ref.id, ref,
    exists: () => !!entrada,
    data: () => (entrada ? copia(entrada.datos) : undefined)
});

/* ── lecturas y escrituras sueltas ── */

export async function getDoc(ref) { await espera(); return instantanea(ref, almacen.get(ref.path)); }

export async function getDocs(q) {
    await espera();
    const docs = [];
    for (const [path, e] of almacen) {
        if (!path.startsWith(q.col + "/")) continue;
        if (q.filtros.every((f) => f.op === "==" && e.datos[f.campo] === f.valor)) {
            const ref = { tipo: "doc", col: q.col, id: path.split("/")[1], path };
            docs.push(instantanea(ref, e));
        }
    }
    return { docs };
}

function escribir(path, datos) {
    const previo = almacen.get(path);
    almacen.set(path, { datos, version: (previo ? previo.version : 0) + 1 });
}

export async function setDoc(ref, datos) { await espera(); escribir(ref.path, aplicar({}, datos)); }

export async function addDoc(col, datos) {
    await espera();
    const ref = doc(col);
    escribir(ref.path, aplicar({}, datos));
    return ref;
}

export async function updateDoc(ref, parche) {
    await espera();
    const e = almacen.get(ref.path);
    if (!e) throw Object.assign(new Error("No existe " + ref.path), { code: "not-found" });
    escribir(ref.path, aplicar(e.datos, parche));
}

export async function deleteDoc(ref) { await espera(); almacen.delete(ref.path); }

export function onSnapshot() { return () => {}; }
export function initializeFirestore() { return { falso: true }; }

/* ── transacciones ── */

export async function runTransaction(_db, fn) {

    for (let intento = 1; intento <= 8; intento++) {

        const lecturas = new Map();      // path → versión leída
        const escrituras = [];

        const tx = {
            async get(ref) {
                if (escrituras.length) throw new Error("Firestore: las lecturas van ANTES de las escrituras en una transacción.");
                await espera();
                const e = almacen.get(ref.path);
                lecturas.set(ref.path, e ? e.version : 0);
                return instantanea(ref, e);
            },
            set(ref, datos) { escrituras.push({ op: "set", ref, datos }); return tx; },
            update(ref, parche) { escrituras.push({ op: "update", ref, parche }); return tx; },
            delete(ref) { escrituras.push({ op: "delete", ref }); return tx; }
        };

        const resultado = await fn(tx);           // si lanza, se propaga y no se escribe nada

        await espera();

        // Confirmación ATÓMICA (sin ningún await): ¿cambió algo de lo que se leyó?
        let choque = false;
        for (const [path, version] of lecturas) {
            const e = almacen.get(path);
            if ((e ? e.version : 0) !== version) { choque = true; break; }
        }

        if (choque) {
            registro.transaccionesReintentadas++;
            registro.reintentosMaximos = Math.max(registro.reintentosMaximos, intento);
            continue;
        }

        for (const w of escrituras) {
            if (w.op === "set") escribir(w.ref.path, aplicar({}, w.datos));
            else if (w.op === "delete") almacen.delete(w.ref.path);
            else {
                const e = almacen.get(w.ref.path);
                if (!e) throw Object.assign(new Error("No existe " + w.ref.path), { code: "not-found" });
                escribir(w.ref.path, aplicar(e.datos, w.parche));
            }
        }

        return resultado;
    }

    throw new Error("La transacción no pudo confirmarse tras varios reintentos.");
}

/* ── para las pruebas ── */

export function __reiniciar() { almacen.clear(); registro.transaccionesReintentadas = 0; registro.reintentosMaximos = 0; }
export function __todos(col) {
    return [...almacen].filter(([p]) => p.startsWith(col + "/")).map(([p, e]) => ({ id: p.split("/")[1], ...copia(e.datos) }));
}
export function __poner(path, datos) { almacen.set(path, { datos: copia(datos), version: 1 }); }
export function __leer(path) { const e = almacen.get(path); return e ? copia(e.datos) : null; }
