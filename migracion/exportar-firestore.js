/* =========================================================
   INLOTRANS
   Exportación completa de Firebase a archivos JSON

   Solo LEE de Firebase: no modifica ni borra nada, así que se
   puede correr cuantas veces se quiera (ensayos + corte final).

   Saca:
     - todas las colecciones raíz de Firestore, con sus
       subcolecciones (p. ej. config/{op}/privado/...)
     - todos los usuarios de Authentication, con el hash de su
       contraseña, para no obligarlos a cambiarla en Postgres

   Uso:
     1. Poner la clave de cuenta de servicio en
        migracion/clave-servicio.json (NO se sube a git)
     2. npm install
     3. npm run exportar

   Resultado: migracion/export/<fecha-hora>/*.json
   ========================================================= */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp, GeoPoint, DocumentReference } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const aqui = dirname(fileURLToPath(import.meta.url));

const rutaClave = process.env.CLAVE_SERVICIO || join(aqui, "clave-servicio.json");
const clave = JSON.parse(readFileSync(rutaClave, "utf8"));

initializeApp({ credential: cert(clave) });

const db = getFirestore();
const auth = getAuth();


/* =========================================================
   CONVERSIÓN DE TIPOS DE FIRESTORE

   JSON no tiene fechas ni referencias. Se marcan con "__tipo"
   para que el script de importación sepa convertirlas a
   timestamptz, etc., en vez de dejarlas como texto suelto.
   ========================================================= */

function convertir(valor) {

    if (valor instanceof Timestamp) {
        return { __tipo: "timestamp", iso: valor.toDate().toISOString() };
    }

    if (valor instanceof GeoPoint) {
        return { __tipo: "geopoint", lat: valor.latitude, lng: valor.longitude };
    }

    if (valor instanceof DocumentReference) {
        return { __tipo: "referencia", ruta: valor.path };
    }

    if (Buffer.isBuffer(valor) || valor instanceof Uint8Array) {
        return { __tipo: "bytes", base64: Buffer.from(valor).toString("base64") };
    }

    if (Array.isArray(valor)) {
        return valor.map(convertir);
    }

    if (valor && typeof valor === "object") {
        return Object.fromEntries(
            Object.entries(valor).map(([k, v]) => [k, convertir(v)])
        );
    }

    return valor;
}


/* =========================================================
   LECTURA RECURSIVA DE UNA COLECCIÓN

   Cada documento queda como { id, ruta, datos, subcolecciones }.
   ========================================================= */

async function exportarColeccion(refColeccion) {

    const snap = await refColeccion.get();
    const documentos = [];

    for (const doc of snap.docs) {

        const subcolecciones = {};

        for (const sub of await doc.ref.listCollections()) {
            subcolecciones[sub.id] = await exportarColeccion(sub);
        }

        documentos.push({
            id: doc.id,
            ruta: doc.ref.path,
            datos: convertir(doc.data()),
            ...(Object.keys(subcolecciones).length ? { subcolecciones } : {})
        });
    }

    return documentos;
}


function contar(documentos) {
    return documentos.reduce(
        (total, d) => total + 1 +
            Object.values(d.subcolecciones || {}).reduce((t, s) => t + contar(s), 0),
        0
    );
}


/* =========================================================
   USUARIOS DE AUTHENTICATION
   ========================================================= */

async function exportarUsuarios() {

    const usuarios = [];
    let pagina;

    do {
        const res = await auth.listUsers(1000, pagina);

        for (const u of res.users) {
            usuarios.push({
                uid: u.uid,
                email: u.email ?? null,
                emailVerificado: u.emailVerified,
                deshabilitado: u.disabled,
                nombreVisible: u.displayName ?? null,
                passwordHash: u.passwordHash ?? null,
                passwordSalt: u.passwordSalt ?? null,
                creado: u.metadata.creationTime,
                ultimoIngreso: u.metadata.lastSignInTime ?? null
            });
        }

        pagina = res.pageToken;

    } while (pagina);

    return usuarios;
}


/* =========================================================
   PRINCIPAL
   ========================================================= */

const marca = new Date().toISOString().replace(/[:.]/g, "-");
const carpeta = join(aqui, "export", marca);
mkdirSync(carpeta, { recursive: true });

const resumen = { exportadoEn: new Date().toISOString(), proyecto: clave.project_id, colecciones: {} };

for (const col of await db.listCollections()) {

    const documentos = await exportarColeccion(col);
    writeFileSync(join(carpeta, `${col.id}.json`), JSON.stringify(documentos, null, 2));

    resumen.colecciones[col.id] = { documentos: documentos.length, incluyendoSubcolecciones: contar(documentos) };
    console.log(`✔ ${col.id}: ${documentos.length} documentos`);
}

const usuarios = await exportarUsuarios();
writeFileSync(join(carpeta, "_auth-usuarios.json"), JSON.stringify(usuarios, null, 2));
resumen.usuariosAuth = usuarios.length;
resumen.usuariosSinHash = usuarios.filter(u => !u.passwordHash).length;
console.log(`✔ Authentication: ${usuarios.length} usuarios`);

writeFileSync(join(carpeta, "_resumen.json"), JSON.stringify(resumen, null, 2));

console.log(`\nListo → ${carpeta}`);

if (resumen.usuariosSinHash) {
    console.warn(
        `\n⚠ ${resumen.usuariosSinHash} usuarios salieron sin hash de contraseña. ` +
        "La cuenta de servicio necesita el rol 'Firebase Authentication Admin' para leerlos."
    );
}
