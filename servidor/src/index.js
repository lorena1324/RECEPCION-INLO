/* =========================================================
   INLOTRANS
   Servidor: el sistema + API REST + tiempo real (Socket.IO)

   Sirve la app tal cual está en la raíz del proyecto: abrir
   http://localhost:3100 lleva al login (index.html), igual que
   Live Server. La API (/api) y Socket.IO quedan listos para
   cuando los datos pasen de Firebase a PostgreSQL; Socket.IO
   reemplazará a los onSnapshot de Firestore.
   ========================================================= */

import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { Server } from "socket.io";

import { pool } from "./db.js";
// API DE IZTECH DESACTIVADA (incidente de producción). Para reactivar: descomentar estos imports
// y los bloques marcados "IZTECH" más abajo (y las líneas IZTECH_* de servidor/.env).
// import { ClienteIztech, leerConfigIztech } from "./iztech.js";
// import { ServicioCajas, leerConfigCajas } from "./cajasServicio.js";
// import { crearAutenticador } from "./auth.js";
// import { montarRutasCajas } from "./rutasCajas.js";
// import { leerMula20Activa } from "./tiposVehiculo.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const PUERTO = Number(process.env.PUERTO) || 3100;

const app = express();
const servidor = createServer(app);
export const io = new Server(servidor);

app.use(express.json());

// El único cliente de Iztech: el token vive aquí, en el servidor, y no sale de él.
// IZTECH (desactivado):
// export const iztech = new ClienteIztech(leerConfigIztech());
//
// // Cajas por vehículo: consulta a Iztech cada pocos segundos y empuja los cambios.
// const configCajas = leerConfigCajas();
// export const cajas = new ServicioCajas(iztech, configCajas, { categorias: { mula20Activa: leerMula20Activa() } });
//
// // Quién pide los datos: la sesión de Firebase de la aplicación.
// const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "sensoria-c4616";
// const autenticador = crearAutenticador({ projectId: FIREBASE_PROJECT_ID });


/* =========================================================
   API
   ========================================================= */

app.get("/api/salud", async (_req, res) => {

    let baseDatos = "sin configurar";

    if (pool) {
        try {
            await pool.query("select 1");
            baseDatos = "ok";
        } catch (error) {
            baseDatos = `error: ${error.message}`;
        }
    }

    res.json({ servidor: "ok", baseDatos });
});

/* Estado de la conexión con Iztech: si está configurada, a qué servidor y cómo
   salió la última consulta. Nunca devuelve el token. Los endpoints con DATOS de
   Iztech (cajas, m³ por vehículo) se agregan cuando se conozcan las vistas, y
   SOLO detrás de autenticación: esta API todavía no la tiene. */
// IZTECH (desactivado):
// app.get("/api/iztech/estado", (_req, res) => {
//     res.json({ ...iztech.estado(), cajas: cajas.estado() });
// });

/* =========================================================
   EL SISTEMA

   Solo se publican las carpetas de la app. Servir la raíz
   entera expondría lo que NO es público: la clave de Firebase
   de migracion/, servidor/.env, node_modules, .git…
   ========================================================= */

const raiz = join(aqui, "../..");

for (const carpeta of ["admin", "css", "js", "operaciones", "shared"]) {
    app.use(`/${carpeta}`, express.static(join(raiz, carpeta)));
}

app.get("/", (_req, res) => res.sendFile(join(raiz, "index.html")));
app.get("/index.html", (_req, res) => res.sendFile(join(raiz, "index.html")));


// IZTECH (desactivado): rutas /api/cajas, Socket.IO autenticado y el temporizador de consulta.
// montarRutasCajas({ app, io, autenticador, cajas, operaciones: configCajas.almacenes });
// cajas.iniciar();

servidor.listen(PUERTO, () => {
    console.log(`INLOTRANS en http://localhost:${PUERTO}  (login)`);
});
