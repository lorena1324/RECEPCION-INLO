import test from "node:test";
import assert from "node:assert/strict";

import { ClienteIztech, filasDeRespuesta, filtroEn, leerConfigIztech, valorSeguro } from "../src/iztech.js";

const TOKEN = "token-secreto-de-prueba-123";
const config = (extra = {}) => ({ urlBase: "https://api.ejemplo.test/v1/", token: TOKEN, copiaSegundos: 10, configurado: true, ...extra });

const respuesta = (cuerpo, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => cuerpo });
const buena = (filas) => respuesta({ code: 200, message: filas, metadata: { resultset: { count: filas.length } } });

test("sin URL o sin token queda 'no configurado' y no consulta", async () => {
    assert.equal(leerConfigIztech({}).configurado, false);
    assert.equal(leerConfigIztech({ IZTECH_URL_BASE: "https://x.test" }).configurado, false);
    assert.equal(leerConfigIztech({ IZTECH_URL_BASE: "https://x.test", IZTECH_TOKEN: "t" }).configurado, true);

    const cliente = new ClienteIztech(leerConfigIztech({}), { fetchFn: () => { throw new Error("no debía llamar"); } });
    await assert.rejects(() => cliente.consultarVista("Vista.Uno"), /no está configurado/);
});

test("la URL base siempre termina en /", () => {
    assert.equal(leerConfigIztech({ IZTECH_URL_BASE: "https://x.test/api", IZTECH_TOKEN: "t" }).urlBase, "https://x.test/api/");
});

test("manda el token en el encabezado y devuelve las filas", async () => {
    let visto;
    const cliente = new ClienteIztech(config(), { fetchFn: async (url, op) => { visto = { url, op }; return buena([{ a: 1 }, { a: 2 }]); } });

    const r = await cliente.consultarVista("Vista.Uno", { take: 10, orderby: "Id asc" });

    assert.equal(r.filas.length, 2);
    assert.equal(r.total, 2);
    assert.equal(visto.op.headers.token, TOKEN);
    assert.match(visto.url, /^https:\/\/api\.ejemplo\.test\/v1\/Vista\.Uno\?/);
    assert.match(visto.url, /take=10/);
});

test("HTTP 200 con code 406 es un rechazo, no datos (la trampa de iLogic)", async () => {
    const cliente = new ClienteIztech(config(), { fetchFn: async () => respuesta({ code: 406, message: "Access denied" }) });
    await assert.rejects(() => cliente.consultarVista("Vista.Uno"), /code 406.*Access denied/);
});

test("una respuesta incompleta se rechaza", () => {
    assert.throws(() => filasDeRespuesta({ code: 200, message: [{}, {}], metadata: { resultset: { count: 5 } } }, { take: 10 }), /2 de 5 filas esperadas/);
    // count es el TOTAL: pedir 3 de 353.272 y recibir 3 es correcto (verificado contra la API real)
    assert.equal(filasDeRespuesta({ code: 200, message: [{}, {}, {}], metadata: { resultset: { count: 353272 } } }, { take: 3 }).total, 353272);
    // segunda página: quedaban 2 por traer
    assert.equal(filasDeRespuesta({ code: 200, message: [{}, {}], metadata: { resultset: { count: 12 } } }, { take: 5, skip: 10 }).filas.length, 2);
});

test("el token nunca aparece en un error ni en el estado", async () => {
    const cliente = new ClienteIztech(config(), { fetchFn: async () => respuesta({}, { ok: false, status: 500 }) });
    await assert.rejects(() => cliente.consultarVista("Vista.Uno"), (e) => !e.message.includes(TOKEN));
    assert.ok(!JSON.stringify(cliente.estado()).includes(TOKEN));
    assert.equal(cliente.estado().servidor, "api.ejemplo.test");
    assert.equal(cliente.estado().ultimaConsultaOk, false);
});

test("dentro de los 10 s de copia no vuelve a llamar", async () => {
    let llamadas = 0;
    let reloj = new Date("2026-10-19T10:00:00Z");
    const cliente = new ClienteIztech(config(), { fetchFn: async () => { llamadas++; return buena([{ a: 1 }]); }, ahora: () => reloj });

    await cliente.consultarVista("Vista.Uno");
    reloj = new Date("2026-10-19T10:00:08Z");
    const r = await cliente.consultarVista("Vista.Uno");
    assert.equal(llamadas, 1);
    assert.equal(r.deCopia, true);

    reloj = new Date("2026-10-19T10:00:11Z");
    await cliente.consultarVista("Vista.Uno");
    assert.equal(llamadas, 2);
});

test("dos pantallas a la vez hacen UNA sola llamada", async () => {
    let llamadas = 0;
    const cliente = new ClienteIztech(config(), { fetchFn: async () => { llamadas++; await new Promise((r) => setTimeout(r, 20)); return buena([{ a: 1 }]); } });

    const [a, b] = await Promise.all([cliente.consultarVista("Vista.Uno"), cliente.consultarVista("Vista.Uno")]);

    assert.equal(llamadas, 1);
    assert.equal(a.filas.length, 1);
    assert.equal(b.filas.length, 1);
});

test("si Iztech falla y hay copia vieja, se sirve la copia marcada como obsoleta", async () => {
    let falla = false;
    let reloj = new Date("2026-10-19T10:00:00Z");
    const cliente = new ClienteIztech(config(), {
        fetchFn: async () => (falla ? respuesta({}, { ok: false, status: 503 }) : buena([{ a: 1 }])),
        ahora: () => reloj
    });

    await cliente.consultarVista("Vista.Uno");
    falla = true;
    reloj = new Date("2026-10-19T11:00:00Z");

    const r = await cliente.consultarVista("Vista.Uno");
    assert.equal(r.obsoleta, true);
    assert.equal(r.consultadoEn.toISOString(), "2026-10-19T10:00:00.000Z");
    assert.equal(cliente.estado().ultimaConsultaOk, false);
});

test("sin copia, el error llega", async () => {
    const cliente = new ClienteIztech(config(), { fetchFn: async () => respuesta({}, { ok: false, status: 503 }) });
    await assert.rejects(() => cliente.consultarVista("Vista.Uno"), /HTTP 503/);
});

test("nombres de vista y parámetros raros se rechazan antes de llamar", async () => {
    const cliente = new ClienteIztech(config(), { fetchFn: () => { throw new Error("no debía llamar"); } });
    await assert.rejects(() => cliente.consultarVista("../secreto"), /no válido/);
    await assert.rejects(() => cliente.consultarVista("Vista.Uno", { take: "10; drop" }), /entero/);
    await assert.rejects(() => cliente.consultarVista("Vista.Uno", { select: "a' OR '1'='1" }), /no permitidos/);
});

test("los filtros no dejan colar comillas", () => {
    assert.equal(valorSeguro("PEPSICO"), "'PEPSICO'");
    assert.throws(() => valorSeguro("x' OR '1'='1"), /no permitido/);
    assert.equal(filtroEn("WarehouseCode", ["MQ", "J3"]), `"WarehouseCode" IN ('MQ','J3')`);
    assert.throws(() => filtroEn('Campo"; --', ["a"]), /Campo no permitido/);
});
