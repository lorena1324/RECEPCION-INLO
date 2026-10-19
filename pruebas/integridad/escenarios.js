/* =========================================================
   Escenarios de integridad: dos usuarios a la vez

   Corre el código REAL de shared/services/vehiculos.js contra el
   Firestore falso (transacciones optimistas, latencia al azar). Cada
   escenario es una situación que antes dejaba datos duplicados o mala
   trazabilidad.
   ========================================================= */

import * as v from "../../shared/services/vehiculos.js";
import { ErrorIntegridad, claveDePlaca, TOPE_SALTO_AVANCE, TOPE_TANDA } from "../../shared/services/integridad.js";
import { __reiniciar, __todos, __poner, __leer, registro } from "./fake-firestore.js";
import { mostrarRechazo } from "../../shared/components/alertaIntegridad.js";
import { errorDuplicado } from "../../shared/services/integridad.js";

const salida = document.getElementById("log");
let fallas = 0, pruebas = 0;

const log = (m) => { salida.textContent += m + "\n"; };
const ok = (condicion, mensaje) => { pruebas++; if (!condicion) fallas++; log((condicion ? "OK    " : "FALLA ") + mensaje); };
const titulo = (t) => log("\n── " + t);

const ahora = () => new Date().toISOString().slice(0, 16);

const datos = (placa, extra) => ({
    conductor: "Conductor", placa, horaEntrada: ahora(), programado: "No programado", ubicacion: "Muelle", numeroMuelle: 3,
    bahia: "A", canal: "MQ", destino: "Muelle 3", tipo: "Descargue", tipologia: "t1", tipologiaNombre: "Turbo", ...extra
});

const resultados = (lista) => ({
    buenos: lista.filter((r) => r.status === "fulfilled"),
    malos: lista.filter((r) => r.status === "rejected").map((r) => r.reason)
});

const codigo = (e) => (e instanceof ErrorIntegridad ? e.codigo : "OTRO:" + (e && e.message));

async function vehiculo(placa, extra, op) {
    const id = await v.crearRegistro(op || "J3", datos(placa, extra), "Portería");
    return id;
}

const salidaDe = (id, quien) => v.registrarSalida(id, ahora(), "", quien);
const eventos = (r, tipo) => (r.historial || []).filter((h) => h.tipo === tipo);

async function escenario(nombre, fn) {
    titulo(nombre);
    __reiniciar();
    try { await fn(); } catch (e) { fallas++; pruebas++; log("FALLA el escenario lanzó: " + (e && e.stack || e)); }
}

try {

    /* ───────────── 1. LA MISMA PLACA A LA VEZ ───────────── */

    await escenario("Dos operarios registran la MISMA placa al mismo tiempo (escrita de dos formas)", async () => {
        const r = resultados(await Promise.allSettled([
            v.crearRegistro("J3", datos("SVD 390"), "Ana"),
            v.crearRegistro("J3", datos("svd390"), "Beto")
        ]));
        ok(r.buenos.length === 1, "solo UNO se crea (" + r.buenos.length + ")");
        ok(r.malos.length === 1 && codigo(r.malos[0]) === "PLACA_DUPLICADA", "el otro recibe PLACA_DUPLICADA");
        ok(__todos("vehiculos").length === 1, "queda UN solo vehículo en la base");
        ok(__todos("placasActivas").length === 1, "queda UN solo candado");
        log("   mensaje: " + r.malos[0].message);
    });

    await escenario("Veinte clics simultáneos con la misma placa", async () => {
        const lista = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => v.crearRegistro("J3", datos("TAL 555"), "U" + i)));
        const r = resultados(lista);
        ok(r.buenos.length === 1, "solo uno de veinte se crea (" + r.buenos.length + ")");
        ok(r.malos.every((e) => codigo(e) === "PLACA_DUPLICADA"), "los 19 restantes: PLACA_DUPLICADA");
        ok(__todos("vehiculos").length === 1, "un solo vehículo");
        log("   (transacciones reintentadas por choque: " + registro.transaccionesReintentadas + ")");
    });

    await escenario("Placas DISTINTAS a la vez: ninguna se bloquea (sin falsos positivos)", async () => {
        const r = resultados(await Promise.allSettled(["AAA111", "BBB222", "CCC333", "DDD444", "EEE555"].map((p) => v.crearRegistro("J3", datos(p), "Ana"))));
        ok(r.buenos.length === 5 && r.malos.length === 0, "las 5 se crean");
        ok(__todos("placasActivas").length === 5, "5 candados");
    });

    await escenario("La misma placa en OTRA bodega sí se permite", async () => {
        await v.crearRegistro("J3", datos("SVD 390"), "Ana");
        const id = await v.crearRegistro("J4", datos("SVD 390", { destino: "Muelle 9" }), "Beto");
        ok(!!id, "en J4 se crea aunque en J3 esté activa");
        ok(__todos("vehiculos").length === 2, "dos vehículos, uno por bodega");
    });

    await escenario("Un activo ANTIGUO (sin candado) también bloquea", async () => {
        __poner("vehiculos/viejo1", { operacion: "J3", placa: "WNW 948", horaSalida: null, horaEntrada: "2026-10-19T08:00", operadorEntrada: "Carlos", destino: "Patio" });
        let e = null;
        try { await v.crearRegistro("J3", datos("WNW948"), "Ana"); } catch (x) { e = x; }
        ok(e && codigo(e) === "PLACA_DUPLICADA", "se rechaza contra el activo sin candado");
        ok(e && /Carlos/.test(e.message), "el mensaje dice quién lo registró");
    });

    await escenario("Un candado VENCIDO (su vehículo ya no existe) no deja la placa encerrada", async () => {
        __poner("placasActivas/J3_QQQ111", { vehiculoId: "fantasma", placa: "QQQ111", placaClave: "QQQ111", operacion: "J3" });
        const id = await v.crearRegistro("J3", datos("QQQ111"), "Ana");
        ok(!!id, "se puede registrar");
        ok(__leer("placasActivas/J3_QQQ111").vehiculoId === id, "el candado pasó al vehículo nuevo");
    });


    /* ───────────── 2. LA SALIDA DOS VECES ───────────── */

    await escenario("Dos personas pulsan «Salida» al mismo tiempo", async () => {
        const id = await vehiculo("SVD 390");
        const r = resultados(await Promise.allSettled([salidaDe(id, "Ana"), salidaDe(id, "Beto")]));
        ok(r.buenos.length === 1, "solo UNA salida se registra (" + r.buenos.length + ")");
        ok(r.malos.length === 1 && codigo(r.malos[0]) === "YA_SALIO", "la otra recibe YA_SALIO");
        const reg = __leer("vehiculos/" + id);
        ok(eventos(reg, "salida").length === 1, "el historial tiene UN solo evento de salida");
        ok(["Ana", "Beto"].includes(reg.operadorSalida) && reg.operadorSalida === eventos(reg, "salida")[0].operador, "el operario de la salida coincide con el del historial");
        ok(__todos("placasActivas").length === 0, "el candado se liberó");
        log("   mensaje: " + r.malos[0].message);
    });

    await escenario("Doble clic de la MISMA persona", async () => {
        const id = await vehiculo("SVD 390");
        const r = resultados(await Promise.allSettled([salidaDe(id, "Ana"), salidaDe(id, "Ana"), salidaDe(id, "Ana")]));
        ok(r.buenos.length === 1 && eventos(__leer("vehiculos/" + id), "salida").length === 1, "una sola salida de tres clics");
    });

    await escenario("Después de salir, la placa se puede volver a registrar (nuevo ciclo)", async () => {
        const id = await vehiculo("SVD 390");
        await salidaDe(id, "Ana");
        const nuevo = await vehiculo("SVD 390");
        ok(!!nuevo && nuevo !== id, "reingreso del mismo camión: nuevo registro");
        ok(__todos("vehiculos").length === 2, "dos registros (el histórico y el activo)");
    });

    await escenario("Un contenedor sin cabezote no sale (segunda línea de defensa)", async () => {
        const id = await vehiculo("SVD 390");
        __poner("vehiculos/" + id, { ...__leer("vehiculos/" + id), sinCabezote: true });     // lo marca el supervisor después de la entrada
        let e = null; try { await salidaDe(id, "Ana"); } catch (x) { e = x; }
        ok(e && codigo(e) === "SIN_CABEZOTE", "SIN_CABEZOTE");
        ok(!__leer("vehiculos/" + id).horaSalida, "no quedó con salida");
    });

    await escenario("Cancelar y registrar salida a la vez: gana uno solo", async () => {
        const id = await vehiculo("SVD 390");
        const r = resultados(await Promise.allSettled([salidaDe(id, "Ana"), v.cancelarVehiculo(id, { motivo: "No cargó" }, "Sup")]));
        ok(r.buenos.length === 1 && r.malos.length === 1 && codigo(r.malos[0]) === "YA_SALIO", "uno gana, el otro YA_SALIO");
        const reg = __leer("vehiculos/" + id);
        ok(eventos(reg, "salida").length + eventos(reg, "cancelacion").length === 1, "un solo evento de cierre en el historial");
    });

    await escenario("Mover un vehículo que otro acaba de despachar", async () => {
        const id = await vehiculo("SVD 390");
        await salidaDe(id, "Ana");
        let e = null; try { await v.actualizarUbicacion(id, { ubicacion: "Patio", destino: "Patio" }, "Beto"); } catch (x) { e = x; }
        ok(e && codigo(e) === "YA_SALIO", "no se mueve un vehículo que ya salió");
        ok(eventos(__leer("vehiculos/" + id), "ubicacion").length === 0, "no se escribió ninguna ubicación posterior a la salida");
    });

    await escenario("Eliminar un registro libera su placa", async () => {
        const id = await vehiculo("SVD 390");
        await v.eliminarRegistro(id);
        ok(__todos("vehiculos").length === 0 && __todos("placasActivas").length === 0, "se fueron el vehículo y su candado");
        ok(!!(await vehiculo("SVD 390")), "la placa vuelve a estar libre");
    });


    /* ───────────── 3. EL AVANCE ───────────── */

    await escenario("Dos supervisores ven 40 % y suben a la vez (+10 y +5): nadie pisa a nadie", async () => {
        const id = await vehiculo("SVD 390", { avanceTipo: "Descargue" });
        // Ya venía en 40 % de hace rato (sin subidas recientes que cuenten para la tanda).
        __poner("vehiculos/" + id, { ...__leer("vehiculos/" + id), avancePorcentaje: 40 });
        const r = resultados(await Promise.allSettled([
            v.actualizarAvance(id, { avanceTipo: "Descargue", porcentaje: 50, esperado: 40 }, "Ana"),
            v.actualizarAvance(id, { avanceTipo: "Descargue", porcentaje: 45, esperado: 40 }, "Beto")
        ]));
        ok(r.buenos.length === 1, "solo UNA actualización se guarda");
        ok(r.malos.length === 1 && codigo(r.malos[0]) === "AVANCE_CAMBIO", "la otra recibe AVANCE_CAMBIO");
        const reg = __leer("vehiculos/" + id);
        ok(reg.avancePorcentaje === 50 || reg.avancePorcentaje === 45, "el avance es el de la ganadora (" + reg.avancePorcentaje + "), no una mezcla");
        ok(r.malos[0].detalle.actual === reg.avancePorcentaje, "el mensaje le dice el valor ACTUAL");
        log("   mensaje: " + r.malos[0].message);
    });

    await escenario("Avance legítimo, a su ritmo: se acepta", async () => {
        const id = await vehiculo("SVD 390", { avanceTipo: "Descargue" });
        let esperado = 0;
        for (const p of [10, 20, 30]) { await v.actualizarAvance(id, { avanceTipo: "Descargue", porcentaje: p, esperado }, "Ana"); esperado = p; }
        ok(__leer("vehiculos/" + id).avancePorcentaje === 30, "0 → 10 → 20 → 30 sin problema");
    });

    await escenario("Clics seguidos: la tanda se frena (no 0 → 100 a base de +10)", async () => {
        const id = await vehiculo("SVD 390", { avanceTipo: "Descargue" });
        let esperado = 0, e = null;
        for (let p = 10; p <= 100 && !e; p += 10) {
            try { await v.actualizarAvance(id, { avanceTipo: "Descargue", porcentaje: p, esperado }, "Ana"); esperado = p; } catch (x) { e = x; }
        }
        ok(e && codigo(e) === "AVANCE_TANDA", "se frena con AVANCE_TANDA");
        ok(esperado <= TOPE_TANDA, "no pasó de " + TOPE_TANDA + " puntos en la tanda (llegó a " + esperado + ")");
        ok(__leer("vehiculos/" + id).avancePorcentaje === esperado, "el avance guardado es el último aceptado");
        log("   mensaje: " + e.message);
    });

    await escenario("Saltar de golpe: 0 → 100 y 0 → 30", async () => {
        const id = await vehiculo("SVD 390", { avanceTipo: "Descargue" });
        let e1 = null, e2 = null;
        try { await v.actualizarAvance(id, { avanceTipo: "Descargue", porcentaje: 100, esperado: 0 }, "Ana"); } catch (x) { e1 = x; }
        try { await v.actualizarAvance(id, { avanceTipo: "Descargue", porcentaje: TOPE_SALTO_AVANCE + 5, esperado: 0 }, "Ana"); } catch (x) { e2 = x; }
        ok(e1 && codigo(e1) === "AVANCE_SALTO", "0 → 100: AVANCE_SALTO");
        ok(e2 && codigo(e2) === "AVANCE_SALTO", "0 → " + (TOPE_SALTO_AVANCE + 5) + ": AVANCE_SALTO");
        ok(!__leer("vehiculos/" + id).avancePorcentaje, "el avance sigue en 0");
        log("   mensaje: " + e1.message);
    });

    await escenario("Bajar o corregir el avance siempre se puede; el backfill del admin salta los topes", async () => {
        const id = await vehiculo("SVD 390", { avanceTipo: "Descargue" });
        await v.actualizarAvance(id, { avanceTipo: "Descargue", porcentaje: 20, esperado: 0 }, "Ana");
        await v.actualizarAvance(id, { avanceTipo: "Descargue", porcentaje: 5, esperado: 20 }, "Ana");
        ok(__leer("vehiculos/" + id).avancePorcentaje === 5, "bajar 20 → 5 se permite");
        await v.actualizarAvance(id, { avanceTipo: "Descargue", porcentaje: 100 }, "Admin (backfill)", { excepcion: true });
        ok(__leer("vehiculos/" + id).avancePorcentaje === 100, "con excepción, 5 → 100 se permite (backfill)");
    });

    await escenario("No se cambia el avance de un vehículo que ya salió", async () => {
        const id = await vehiculo("SVD 390", { avanceTipo: "Descargue" });
        await salidaDe(id, "Ana");
        let e = null; try { await v.actualizarAvance(id, { avanceTipo: "Descargue", porcentaje: 10, esperado: 0 }, "Beto"); } catch (x) { e = x; }
        ok(e && codigo(e) === "YA_SALIO", "YA_SALIO");
    });

    await escenario("Cada subida deja en el historial de dónde partió (de ahí sale la tanda)", async () => {
        const id = await vehiculo("SVD 390", { avanceTipo: "Descargue" });
        await v.actualizarAvance(id, { avanceTipo: "Descargue", porcentaje: 10, esperado: 0 }, "Ana");
        const e = eventos(__leer("vehiculos/" + id), "avance")[0];
        ok(e && e.anterior === 0 && e.porcentaje === 10 && e.avanceTipo === "Descargue", "el evento trae anterior=0, porcentaje=10 y la fase");
    });


    /* ───────────── 4. REABRIR Y CORREGIR ───────────── */

    await escenario("Dos supervisores anulan la misma salida a la vez", async () => {
        const id = await vehiculo("SVD 390");
        await salidaDe(id, "Ana");
        const rec = __leer("vehiculos/" + id);
        const r = resultados(await Promise.allSettled([v.anularSalida(id, rec, "Error", "Sup1"), v.anularSalida(id, rec, "Error", "Sup2")]));
        ok(r.buenos.length === 1 && r.malos.length === 1 && codigo(r.malos[0]) === "YA_ABIERTO", "una vale, la otra YA_ABIERTO");
        ok(__todos("placasActivas").length === 1, "el vehículo reabierto vuelve a tener su candado");
        ok(eventos(__leer("vehiculos/" + id), "anulacion_salida").length === 1, "un solo evento de anulación");
    });

    await escenario("No se reabre un vehículo si otro ya tomó su placa", async () => {
        const id = await vehiculo("SVD 390");
        await salidaDe(id, "Ana");
        await vehiculo("SVD 390");                                   // el mismo camión vuelve a entrar
        let e = null; try { await v.anularSalida(id, __leer("vehiculos/" + id), "Error", "Sup"); } catch (x) { e = x; }
        ok(e && codigo(e) === "PLACA_DUPLICADA", "PLACA_DUPLICADA: habría dos activos");
    });

    await escenario("Corregir la placa mueve el candado (y respeta las ocupadas)", async () => {
        const a = await vehiculo("AAA 111");
        await vehiculo("BBB 222");
        const rec = __leer("vehiculos/" + a);
        let e = null; try { await v.corregirRegistro(a, { id: a, ...rec }, { placa: "BBB222" }, "Admin"); } catch (x) { e = x; }
        ok(e && codigo(e) === "PLACA_DUPLICADA", "no se puede corregir a una placa que otro tiene activa");

        await v.corregirRegistro(a, { id: a, ...rec }, { placa: "CCC 333" }, "Admin");
        ok(!__leer("placasActivas/J3_AAA111"), "se soltó la placa vieja");
        ok(!!__leer("placasActivas/J3_CCC333") && __leer("vehiculos/" + a).placaClave === "CCC333", "se apartó la nueva y se actualizó placaClave");
        ok(!!(await vehiculo("AAA 111")), "la placa vieja ya se puede registrar");
    });

    await escenario("Las claves de placa", async () => {
        ok(claveDePlaca("SVD 390") === "SVD390" && claveDePlaca(" svd-390 ") === "SVD390" && claveDePlaca(null) === "", "SVD 390 = svd-390 = SVD390");
    });

    /* ───────────── 5. LA ALERTA EN PANTALLA ───────────── */

    await escenario("La alerta de rechazo", async () => {
        const hay = () => document.getElementById("alerta-integridad");

        ok(mostrarRechazo(new Error("sin red")) === false && !hay(), "un error de red NO es un rechazo: lo sigue manejando el panel");

        const e = errorDuplicado({ placa: "SVD 390", destino: "Muelle 3", operadorEntrada: "Ana", horaEntrada: "2026-10-19T14:05" });
        ok(mostrarRechazo(e) === true && !!hay(), "un rechazo de integridad abre la alerta");
        ok(hay().textContent.includes("Esa placa ya está registrada") && hay().textContent.includes("Ana"), "dice qué pasó y quién");
        ok(hay().getAttribute("role") === "alertdialog", "es accesible (alertdialog)");

        mostrarRechazo(errorDuplicado({ placa: "OTRA 111" }));
        ok(document.querySelectorAll("#alerta-integridad").length === 1, "una sola a la vez: la nueva reemplaza a la anterior");

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        ok(!hay(), "Escape la cierra");
    });

} catch (e) { fallas++; log("EXCEPCION GLOBAL: " + (e && e.stack || e)); }

log("\n" + (fallas ? "✖ " + fallas + " FALLA(S)" : "✔ TODO BIEN") + " — " + pruebas + " comprobaciones");
log("FIN");
