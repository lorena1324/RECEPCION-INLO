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

const aqui = dirname(fileURLToPath(import.meta.url));
const PUERTO = Number(process.env.PUERTO) || 3100;

const app = express();
const servidor = createServer(app);
export const io = new Server(servidor);

app.use(express.json());


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


servidor.listen(PUERTO, () => {
    console.log(`INLOTRANS en http://localhost:${PUERTO}  (login)`);
});
