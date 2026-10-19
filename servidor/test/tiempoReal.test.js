import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import express from "express";
import { Server } from "socket.io";
import { io as clienteSocket } from "socket.io-client";

import { ErrorSesion } from "../src/auth.js";
import { ServicioCajas } from "../src/cajasServicio.js";
import { montarRutasCajas } from "../src/rutasCajas.js";

const SESIONES = {
    "tok-j3": { uid: "u3", rol: "supervisor", operacion: "J3" },
    "tok-b9": { uid: "u9", rol: "cliente", operacion: "B9" },
    "tok-admin": { uid: "ua", rol: "administrador", operacion: "" }
};

const autenticador = {
    async autenticar(token) {
        if (!token) throw new ErrorSesion("Falta iniciar sesión.");
        if (!SESIONES[token]) throw new ErrorSesion("La sesión no es válida o venció. Vuelve a iniciar sesión.");
        return SESIONES[token];
    }
};

const mov = (extra = {}) => ({ WarehouseCode: "J3", PrimaryQty: 10, PrimaryUomCode: "CARTON", Vehicle: "WNW948", ShipmentNumber: 1, HandlingUnit: "1", CreatedOn: "2026-10-19T08:00:00", ...extra });
const envio = { Id: 1, DocNum: "9", ShipmentType: "Salida", VehicleCode: "WNW948", VehicleType: "SENCILLO", ModifiedOn: "2026-10-19T08:00:00" };

async function montar() {

    const datos = { envios: [envio], salidas: [mov(), mov({ Vehicle: "BBB222", WarehouseCode: "B9", ShipmentNumber: 2 })], entradas: [] };
    const cliente = {
        configurado: true,
        async consultarVista(vista) {
            const filas = vista.includes("Shipments") ? datos.envios : vista.includes("Outbound") ? datos.salidas : datos.entradas;
            return { filas, total: filas.length };
        }
    };

    const cajas = new ServicioCajas(cliente, { intervaloSegundos: 15, ventanaDias: 2, almacenes: ["J3", "B9"] });
    await cajas.refrescar();

    const app = express();
    const http = createServer(app);
    const io = new Server(http);
    montarRutasCajas({ app, io, autenticador, cajas, operaciones: ["J3", "B9"] });

    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${http.address().port}`;

    const abiertos = [];
    const conectar = (token) => new Promise((resolve, reject) => {
        const s = clienteSocket(url, { auth: { token }, reconnection: false, transports: ["websocket"] });
        abiertos.push(s);
        // El primer "cajas" llega junto con la conexión: se captura desde ya para no perderlo.
        s.inicial = new Promise((r) => s.once("cajas", r));
        s.once("connect", () => resolve(s));
        s.once("connect_error", (e) => { s.close(); reject(e); });
    });

    const cerrar = async () => { abiertos.forEach((s) => s.close()); await io.close(); http.closeAllConnections?.(); };

    return { datos, cajas, url, conectar, cerrar };
}

const siguiente = (socket, evento, ms = 2000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no llegó "${evento}" en ${ms} ms`)), ms);
    socket.once(evento, (d) => { clearTimeout(t); resolve(d); });
});


test("sin sesión o con token falso no se conecta", async () => {
    const m = await montar();
    try {
        await assert.rejects(() => m.conectar(null), /Falta iniciar sesión/);
        await assert.rejects(() => m.conectar("falso"), /no es válida/);
    } finally { await m.cerrar(); }
});

test("HTTP: 401 sin sesión, 403 a otra operación, 200 a la suya y a cualquiera si es administrador", async () => {
    const m = await montar();
    try {
        const pedir = (op, token) => fetch(`${m.url}/api/cajas?operacion=${op}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

        assert.equal((await pedir("J3", null)).status, 401);
        assert.equal((await pedir("J3", "falso")).status, 401);
        assert.equal((await pedir("B9", "tok-j3")).status, 403);

        const propia = await pedir("J3", "tok-j3");
        assert.equal(propia.status, 200);
        const cuerpo = await propia.json();
        assert.equal(cuerpo.vehiculos.WNW948.actual.cajas, 10);
        assert.ok(!cuerpo.vehiculos.BBB222, "no debe ver el vehículo de otra operación");

        assert.equal((await pedir("B9", "tok-admin")).status, 200);
    } finally { await m.cerrar(); }
});

test("al conectar recibe lo de SU operación, y no puede suscribirse a otra", async () => {
    const m = await montar();
    try {
        const s = clienteSocket(m.url, { auth: { token: "tok-j3" }, reconnection: false, transports: ["websocket"] });
        const primero = siguiente(s, "cajas");
        await siguiente(s, "connect");
        const datos = await primero;
        assert.ok(datos.vehiculos.WNW948);
        assert.ok(!datos.vehiculos.BBB222);

        const respuesta = await new Promise((r) => s.emit("suscribir", "B9", r));
        assert.equal(respuesta.ok, false);

        s.close();
    } finally { await m.cerrar(); }
});

test("el administrador puede suscribirse a cualquier operación", async () => {
    const m = await montar();
    try {
        const s = await m.conectar("tok-admin");
        const llegan = siguiente(s, "cajas");
        const r = await new Promise((res) => s.emit("suscribir", "B9", res));
        assert.equal(r.ok, true);
        assert.ok((await llegan).vehiculos.BBB222);
    } finally { await m.cerrar(); }
});

test("un cambio se EMPUJA a los conectados, y llega en mucho menos de 30 s", async () => {
    const m = await montar();
    try {
        const a = await m.conectar("tok-j3");
        const b = await m.conectar("tok-j3");
        await a.inicial; await b.inicial;

        const llegaA = siguiente(a, "cajas"), llegaB = siguiente(b, "cajas");

        const inicio = Date.now();
        m.datos.salidas = [mov({ PrimaryQty: 250 })];
        await m.cajas.refrescar();

        const [da, db] = await Promise.all([llegaA, llegaB]);
        const retardo = Date.now() - inicio;

        assert.equal(da.vehiculos.WNW948.actual.cajas, 250);
        assert.equal(db.vehiculos.WNW948.actual.cajas, 250);
        assert.ok(retardo < 1000, `tardó ${retardo} ms`);   // desde que el servidor ve el dato hasta los dos equipos
    } finally { await m.cerrar(); }
});

test("sin novedades solo hay latido, no se reenvía todo", async () => {
    const m = await montar();
    try {
        const s = await m.conectar("tok-j3");
        await s.inicial;

        let cajasRecibidas = 0;
        s.on("cajas", () => cajasRecibidas++);
        const latido = siguiente(s, "latido");

        await m.cajas.refrescar();             // los mismos datos

        const l = await latido;
        assert.ok(l.generadoEn);
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(cajasRecibidas, 0);
    } finally { await m.cerrar(); }
});

test("a quien está en otra operación no le llega lo de J3", async () => {
    const m = await montar();
    try {
        const j3 = await m.conectar("tok-j3");
        const b9 = await m.conectar("tok-b9");
        await j3.inicial; await b9.inicial;

        let recibioB9 = null;
        b9.on("cajas", (d) => { recibioB9 = d; });

        const llegaJ3 = siguiente(j3, "cajas");
        m.datos.salidas = [mov({ PrimaryQty: 77 })];
        await m.cajas.refrescar();
        await llegaJ3;
        await new Promise((r) => setTimeout(r, 100));

        // B9 recibe SU propia vista (sin el vehículo de J3), nunca los datos de J3
        if (recibioB9) assert.ok(!recibioB9.vehiculos.WNW948);
    } finally { await m.cerrar(); }
});
