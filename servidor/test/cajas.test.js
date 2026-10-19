import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";

import { categoriaDeVehiculo } from "../src/tiposVehiculo.js";
import { agruparCajas, normalizarPlaca } from "../src/cajas.js";
import { ServicioCajas, diaBogota } from "../src/cajasServicio.js";
import { crearAutenticador, ErrorSesion, puedeVer, tokenDeCabecera } from "../src/auth.js";


/* ---------- tipos de vehículo ---------- */

test("Sencillo y Mula 20 se unifican en sencillo; Mula 20 queda por activar", () => {
    assert.equal(categoriaDeVehiculo("SENCILLO"), "sencillo");
    assert.equal(categoriaDeVehiculo("MULA 20"), "sencillo");
    assert.equal(categoriaDeVehiculo("  mula  20 "), "sencillo");
    assert.equal(categoriaDeVehiculo("MULA 20", { mula20Activa: true }), "mula20");
    assert.equal(categoriaDeVehiculo("SENCILLO", { mula20Activa: true }), "sencillo");
});

test("el resto de tipos de iLogic y lo desconocido", () => {
    assert.equal(categoriaDeVehiculo("MULA"), "tractomula");
    assert.equal(categoriaDeVehiculo("MULA 40"), "tractomula");
    assert.equal(categoriaDeVehiculo("MINI MULA"), "miniMula");
    assert.equal(categoriaDeVehiculo("TURBO"), "turbo");
    assert.equal(categoriaDeVehiculo("CAMELLO"), null);     // un tipo nuevo no se adivina
    assert.equal(categoriaDeVehiculo(null), null);
});


/* ---------- agrupación ---------- */

const envio = (extra = {}) => ({ Id: 60635, DocNum: "970960", ShipmentType: "Salida", VehicleCode: "WNW948", VehicleType: "MULA 20", TipoCargue: "PALETIZADO", TruckDriverName: "ARTURO GIRALDO ", CarrierName: "PEPSICO", ModifiedOn: "2026-10-19T08:00:00", ...extra });
const mov = (extra = {}) => ({ WarehouseCode: "J3", PrimaryQty: 10, PrimaryUomCode: "CARTON", Vehicle: "WNW948", ShipmentNumber: 60635, HandlingUnit: "1", CreatedOn: "2026-10-19T08:56:00", ...extra });

test("las placas se normalizan (iLogic a veces trae un espacio al final)", () => {
    assert.equal(normalizarPlaca("WNZ001 "), "WNZ001");
    assert.equal(normalizarPlaca("svd 390"), "SVD390");
    assert.equal(normalizarPlaca(null), "");
});

test("cajas por vehículo: suma CARTON, cuenta estibas distintas y separa otras unidades", () => {
    const r = agruparCajas({
        envios: [envio()],
        salidas: [
            mov({ PrimaryQty: 36, HandlingUnit: "A" }),
            mov({ PrimaryQty: 24, HandlingUnit: "A" }),         // misma estiba
            mov({ PrimaryQty: 40, HandlingUnit: "B" }),
            mov({ PrimaryQty: 5, PrimaryUomCode: "UND", HandlingUnit: "C" }),
            mov({ Vehicle: null, PrimaryQty: 999 })              // ajuste sin vehículo: no cuenta
        ]
    });

    const v = r.WNW948;
    assert.equal(v.actual.cajas, 100);
    assert.equal(v.actual.estibas, 3);
    assert.deepEqual(v.actual.otras, { UND: 5 });
    assert.equal(v.actual.tipo, "Salida");
    assert.equal(v.actual.categoria, "sencillo");            // MULA 20 → sencillo
    assert.equal(v.actual.tipoCargue, "PALETIZADO");
    assert.equal(v.actual.conductor, "ARTURO GIRALDO");
    assert.equal(v.operacion, "J3");
});

test("una entrada cuenta lo descargado, no lo cargado", () => {
    const r = agruparCajas({
        envios: [envio({ Id: 7, ShipmentType: "Entrada", VehicleCode: "SVB441", VehicleType: "MULA" })],
        entradas: [mov({ Vehicle: "SVB441", ShipmentNumber: 7, PrimaryQty: 50 })],
        salidas: [mov({ Vehicle: "SVB441", ShipmentNumber: 7, PrimaryQty: 3 })]
    });
    assert.equal(r.SVB441.actual.tipo, "Entrada");
    assert.equal(r.SVB441.actual.cajas, 50);
    assert.equal(r.SVB441.actual.categoria, "tractomula");
});

test("un envío planeado sin movimientos todavía aparece (el vehículo ya viene)", () => {
    const r = agruparCajas({ envios: [envio({ VehicleCode: "LCM 474", Id: 9 })] });
    assert.equal(r.LCM474.actual.cajas, 0);
    assert.equal(r.LCM474.operacion, "");
});

test("un vehículo con varios envíos: el actual es el de actividad más reciente", () => {
    const r = agruparCajas({
        envios: [envio({ Id: 1 }), envio({ Id: 2 })],
        salidas: [mov({ ShipmentNumber: 1, CreatedOn: "2026-10-18T09:00:00" }), mov({ ShipmentNumber: 2, CreatedOn: "2026-10-19T09:00:00" })]
    });
    assert.equal(r.WNW948.envios.length, 2);
    assert.equal(r.WNW948.actual.id, "2");
});

test("una cantidad no numérica no rompe la suma", () => {
    const r = agruparCajas({ salidas: [mov({ PrimaryQty: "x" }), mov({ PrimaryQty: 4 })] });
    assert.equal(r.WNW948.actual.cajas, 4);
});


/* ---------- servicio ---------- */

const respuestaVista = (filas) => ({ filas, total: filas.length });

function clienteFalso(datos) {
    const llamadas = [];
    return {
        llamadas,
        configurado: true,
        async consultarVista(vista, parametros) {
            llamadas.push({ vista, parametros });
            if (datos.falla) throw new Error("Iztech caído");
            if (vista.includes("Shipments")) return respuestaVista(datos.envios);
            if (vista.includes("Outbound")) return respuestaVista(datos.salidas);
            return respuestaVista(datos.entradas || []);
        }
    };
}

test("el servicio consulta las 3 vistas con ventana de fechas y filtro de almacenes", async () => {
    const c = clienteFalso({ envios: [envio()], salidas: [mov()] });
    const s = new ServicioCajas(c, { intervaloSegundos: 15, ventanaDias: 2, almacenes: ["J3", "B9"] }, { ahora: () => new Date("2026-10-19T15:00:00Z") });

    await s.refrescar();

    assert.equal(c.llamadas.length, 3);
    const salidas = c.llamadas.find((l) => l.vista.includes("Outbound"));
    assert.match(salidas.parametros.where, /"TransactionDate">='2026-10-17'/);
    assert.match(salidas.parametros.where, /"WarehouseCode" IN \('J3','B9'\)/);
    assert.equal(s.paraOperacion("J3").vehiculos.WNW948.actual.cajas, 10);
});

test("el día se cuenta en Bogotá, no en UTC", () => {
    assert.equal(diaBogota(new Date("2026-10-20T02:00:00Z")), "2026-10-19");   // 9 p. m. en Bogotá
});

test("cada operación ve solo lo suyo (y los planeados sin almacén)", async () => {
    const c = clienteFalso({
        envios: [envio({ VehicleCode: "AAA111", Id: 5 })],
        salidas: [mov({ Vehicle: "BBB222", ShipmentNumber: 6, WarehouseCode: "B9" }), mov()]
    });
    const s = new ServicioCajas(c, { intervaloSegundos: 15, ventanaDias: 2, almacenes: ["J3", "B9"] });
    await s.refrescar();

    const j3 = Object.keys(s.paraOperacion("J3").vehiculos).sort();
    assert.ok(j3.includes("WNW948"));
    assert.ok(!j3.includes("BBB222"));
});

test("avisa con cambio=true solo cuando algo cambió, y siempre da latido", async () => {
    const datos = { envios: [envio()], salidas: [mov()] };
    const s = new ServicioCajas(clienteFalso(datos), { intervaloSegundos: 15, ventanaDias: 2, almacenes: ["J3"] });
    const avisos = [];
    s.alCambiar((cambio) => avisos.push(cambio));

    await s.refrescar();                      // primera vez: cambió
    await s.refrescar();                      // igual: solo latido
    datos.salidas = [mov({ PrimaryQty: 99 })];
    await s.refrescar();                      // cambió

    assert.deepEqual(avisos, [true, false, true]);
});

test("si Iztech falla se conserva la última instantánea, marcada como obsoleta", async () => {
    const datos = { envios: [envio()], salidas: [mov()] };
    const s = new ServicioCajas(clienteFalso(datos), { intervaloSegundos: 15, ventanaDias: 2, almacenes: ["J3"] });

    await s.refrescar();
    const antes = s.paraOperacion("J3");
    datos.falla = true;
    const consola = console.error; console.error = () => {};
    await s.refrescar();
    console.error = consola;

    const despues = s.paraOperacion("J3");
    assert.equal(despues.generadoEn, antes.generadoEn);        // la hora REAL del dato
    assert.equal(despues.obsoleta, true);
    assert.equal(s.estado().ok, false);
    assert.match(s.estado().error, /caído/);
});

test("un refresco no se amontona sobre el anterior", async () => {
    let activas = 0, maximo = 0;
    const c = { configurado: true, async consultarVista() { activas++; maximo = Math.max(maximo, activas); await new Promise((r) => setTimeout(r, 15)); activas--; return respuestaVista([]); } };
    const s = new ServicioCajas(c, { intervaloSegundos: 15, ventanaDias: 2, almacenes: ["J3"] });

    await Promise.all([s.refrescar(), s.refrescar(), s.refrescar()]);
    assert.equal(maximo, 3);   // las 3 vistas de UN refresco, en paralelo; los otros dos se saltaron
});


/* ---------- autenticación ---------- */

const PROYECTO = "proyecto-prueba";

async function montarAuth({ perfil = { rol: "supervisor", operacion: "J3", activo: true }, estado = 200 } = {}) {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const firmar = (extra = {}, { audiencia = PROYECTO, emisor = `https://securetoken.google.com/${PROYECTO}`, expira = "1h" } = {}) =>
        new SignJWT({ user_id: "u1", ...extra }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(emisor).setAudience(audiencia).setSubject("u1").setIssuedAt().setExpirationTime(expira).sign(privateKey);

    let lecturas = 0;
    const fetchFn = async (url, op) => {
        lecturas++;
        assert.match(url, /documents\/usuarios\/u1$/);
        assert.ok(op.headers.Authorization.startsWith("Bearer "));
        const f = { rol: { stringValue: perfil.rol }, operacion: { stringValue: perfil.operacion }, activo: { booleanValue: perfil.activo } };
        return { ok: estado === 200, status: estado, json: async () => ({ fields: f }) };
    };

    const a = crearAutenticador({ projectId: PROYECTO, jwks: createLocalJWKSet({ keys: [jwk] }), fetchFn });
    return { a, firmar, lecturas: () => lecturas };
}

test("un token válido da la sesión con su rol y operación", async () => {
    const { a, firmar } = await montarAuth();
    const s = await a.autenticar(await firmar());
    assert.deepEqual({ uid: s.uid, rol: s.rol, operacion: s.operacion }, { uid: "u1", rol: "supervisor", operacion: "J3" });
});

test("sin token, token de otro proyecto o vencido: se rechaza con 401", async () => {
    const { a, firmar } = await montarAuth();
    await assert.rejects(() => a.autenticar(null), (e) => e instanceof ErrorSesion && e.estado === 401);
    await assert.rejects(() => a.autenticar("basura"), (e) => e.estado === 401);
    await assert.rejects(async () => a.autenticar(await firmar({}, { audiencia: "otro-proyecto" })), (e) => e.estado === 401);
    await assert.rejects(async () => a.autenticar(await firmar({}, { emisor: "https://falso.test" })), (e) => e.estado === 401);
    await assert.rejects(async () => a.autenticar(await firmar({}, { expira: "-1h" })), (e) => e.estado === 401);
});

test("un usuario desactivado o sin perfil no entra", async () => {
    const off = await montarAuth({ perfil: { rol: "supervisor", operacion: "J3", activo: false } });
    await assert.rejects(async () => off.a.autenticar(await off.firmar()), (e) => e.estado === 403);

    const sin = await montarAuth({ estado: 404 });
    await assert.rejects(async () => sin.a.autenticar(await sin.firmar()), (e) => e.estado === 403);
});

test("el perfil se guarda en memoria: no se lee Firestore en cada petición", async () => {
    const { a, firmar, lecturas } = await montarAuth();
    const token = await firmar();
    await a.autenticar(token); await a.autenticar(token); await a.autenticar(token);
    assert.equal(lecturas(), 1);
});

test("quién puede ver qué operación", () => {
    const sup = { rol: "supervisor", operacion: "J3" };
    assert.equal(puedeVer(sup, "J3"), true);
    assert.equal(puedeVer(sup, "J4"), false);
    assert.equal(puedeVer({ rol: "administrador", operacion: "" }, "J4"), true);
    assert.equal(puedeVer({ rol: "cliente", operacion: "B9" }, "B9"), true);
    assert.equal(puedeVer(null, "J3"), false);
    assert.equal(puedeVer(sup, ""), false);
});

test("el token se lee de la cabecera Authorization: Bearer", () => {
    assert.equal(tokenDeCabecera("Bearer abc.def"), "abc.def");
    assert.equal(tokenDeCabecera("bearer xyz"), "xyz");
    assert.equal(tokenDeCabecera("Basic abc"), null);
    assert.equal(tokenDeCabecera(undefined), null);
});


/* ---------- la lectura del perfil cuando Firestore falla (HTTP 429) ---------- */

async function montarAuthFlexible() {

    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const firmar = () => new SignJWT({ user_id: "u1" }).setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(`https://securetoken.google.com/${PROYECTO}`).setAudience(PROYECTO).setSubject("u1").setIssuedAt().setExpirationTime("1h").sign(privateKey);

    const caso = { estado: 200, retryAfter: null, demora: 0, cuerpo: "Quota exceeded for quota metric 'Read requests'" };
    const llamadas = { n: 0 };
    const avisos = [];
    let reloj = 1_000_000;

    const fetchFn = async () => {
        llamadas.n++;
        if (caso.demora) await new Promise((r) => setTimeout(r, caso.demora));
        if (caso.estado !== 200) {
            return { ok: false, status: caso.estado, headers: { get: (h) => (h.toLowerCase() === "retry-after" ? caso.retryAfter : null) }, text: async () => caso.cuerpo, json: async () => ({}) };
        }
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ fields: { rol: { stringValue: "supervisor" }, operacion: { stringValue: "J3" } } }) };
    };

    const a = crearAutenticador({ projectId: PROYECTO, jwks: createLocalJWKSet({ keys: [jwk] }), fetchFn, ahora: () => reloj, registrar: (m) => avisos.push(m) });
    return { a, firmar, caso, llamadas, avisos, avanzar: (ms) => { reloj += ms; } };
}

test("Firestore responde 429: se dice 'reintenta en N s' (503) y NO se vuelve a preguntar mientras dure la espera", async () => {
    const m = await montarAuthFlexible();
    m.caso.estado = 429;
    const token = await m.firmar();

    const e1 = await m.a.autenticar(token).catch((e) => e);
    assert.ok(e1 instanceof ErrorSesion);
    assert.equal(e1.estado, 503);
    assert.equal(e1.reintentarEn, 15);
    assert.equal(m.llamadas.n, 1);

    // Cien peticiones seguidas (el socket reintentando + la consulta de respaldo + varias pestañas)
    for (let i = 0; i < 100; i++) await m.a.autenticar(token).catch(() => {});
    assert.equal(m.llamadas.n, 1, "durante la espera no se le pega otra vez a Firestore");
});

test("la espera CRECE si Firestore sigue fallando (15 s, 30 s, 60 s…) y termina cuando responde", async () => {
    const m = await montarAuthFlexible();
    m.caso.estado = 429;
    const token = await m.firmar();

    const esperas = [];
    for (let i = 0; i < 4; i++) {
        const e = await m.a.autenticar(token).catch((x) => x);
        esperas.push(e.reintentarEn);
        m.avanzar(e.reintentarEn * 1000 + 1);          // pasa la espera → se permite un intento
    }
    assert.deepEqual(esperas, [15, 30, 60, 120]);
    assert.equal(m.llamadas.n, 4);

    m.caso.estado = 200;                                // Firestore se recupera
    const sesion = await m.a.autenticar(token);
    assert.equal(sesion.rol, "supervisor");
    const despues = m.llamadas.n;
    await m.a.autenticar(token);
    assert.equal(m.llamadas.n, despues, "recuperado, el perfil vuelve a quedar guardado");
});

test("respeta el Retry-After que pida Firestore", async () => {
    const m = await montarAuthFlexible();
    m.caso.estado = 429; m.caso.retryAfter = "90";
    const e = await m.a.autenticar(await m.firmar()).catch((x) => x);
    assert.equal(e.reintentarEn, 90);
});

test("veinte peticiones JUNTAS hacen UNA sola lectura del perfil", async () => {
    const m = await montarAuthFlexible();
    m.caso.demora = 20;
    const token = await m.firmar();
    const r = await Promise.all(Array.from({ length: 20 }, () => m.a.autenticar(token)));
    assert.equal(m.llamadas.n, 1);
    assert.ok(r.every((s) => s.rol === "supervisor"));
});

test("si Firestore falla pero ya había un perfil guardado, se sigue sirviendo con ese (nadie queda afuera)", async () => {
    const m = await montarAuthFlexible();
    const token = await m.firmar();
    await m.a.autenticar(token);                        // perfil guardado
    m.avanzar(6 * 60_000);                              // pasa su vigencia (5 min)

    m.caso.estado = 429;
    const sesion = await m.a.autenticar(token);         // la lectura falla, pero no se rechaza
    assert.equal(sesion.operacion, "J3");
    assert.equal(m.llamadas.n, 2);

    await m.a.autenticar(token);                        // y en espera no vuelve a preguntar
    assert.equal(m.llamadas.n, 2);
});

test("un 5xx o un corte de red también se frena, igual que el 429", async () => {
    const m = await montarAuthFlexible();
    m.caso.estado = 503;
    const token = await m.firmar();
    const e = await m.a.autenticar(token).catch((x) => x);
    assert.equal(e.estado, 503);
    await m.a.autenticar(token).catch(() => {});
    assert.equal(m.llamadas.n, 1);
});

test("el log avisa la causa UNA vez por minuto, con el detalle de Firestore (sin spam)", async () => {
    const m = await montarAuthFlexible();
    m.caso.estado = 429;
    const token = await m.firmar();

    for (let i = 0; i < 6; i++) { await m.a.autenticar(token).catch(() => {}); m.avanzar(20_000); }
    assert.ok(m.avisos.length >= 1 && m.avisos.length <= 3, `pocos avisos (${m.avisos.length})`);
    assert.match(m.avisos[0], /HTTP 429/);
    assert.match(m.avisos[0], /Quota exceeded/);          // el detalle real: cuota o velocidad
});

test("un 404 o 403 de verdad NO se frena ni se reintenta como si fuera pasajero", async () => {
    const m = await montarAuthFlexible();
    m.caso.estado = 404;
    const e = await m.a.autenticar(await m.firmar()).catch((x) => x);
    assert.equal(e.estado, 403);
    assert.equal(e.reintentarEn, null);
});