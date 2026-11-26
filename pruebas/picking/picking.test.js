/* Cálculos del apartado Picking (shared/services/picking.js). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resumirPicking, resumirMovimientos, pedidoDeTarea, minutosDeTiempo, duracionDeTarea } from "../../shared/services/picking.js";

const tarea = (x) => Object.assign({
    ctsk_id: 1, ctst_name: "Picking", ctsk_task_state: "Complete", ctsk_task_user: "ana",
    ctsk_lines: 10, ctsk_organization_id: 94, ctsk_waiting_date: null,
    ctsk_running_date: "2026-11-20T08:00:00", ctsk_complete_date: "2026-11-20T08:30:00",
    ctti_time_els_value: null
}, x);

test("tiempo del WMS y de inicio a fin", () => {
    assert.equal(minutosDeTiempo("00:08:30"), 8.5);
    assert.equal(minutosDeTiempo("1.00:00:00"), 1440);
    assert.equal(duracionDeTarea(tarea({})), 30);
    assert.equal(duracionDeTarea(tarea({ ctti_time_els_value: "00:10:00" })), 10);
});

test("productividad por operario, filtros y abiertas", () => {
    const r = resumirPicking([
        tarea({ ctsk_id: 1 }),
        tarea({ ctsk_id: 2, ctsk_lines: 20, ctsk_running_date: "2026-11-20T09:00:00", ctsk_complete_date: "2026-11-20T10:00:00" }),
        tarea({ ctsk_id: 3, ctsk_task_user: "luis", ctst_name: "Reposicion", ctsk_lines: 1 }),
        tarea({ ctsk_id: 4, ctsk_complete_date: "2026-11-10T08:30:00", ctsk_running_date: "2026-11-10T08:00:00" }),   // fuera de rango
        tarea({ ctsk_id: 5, ctsk_task_state: "Waiting", ctsk_complete_date: null, ctsk_running_date: null, ctsk_waiting_date: "2026-11-01T08:00:00" }),
        tarea({ ctsk_id: 6, ctsk_running_date: "2026-11-19T08:00:00", ctsk_complete_date: "2026-11-20T08:00:00" })     // 24 h: atípica
    ], { desde: "2026-11-15", hasta: "2026-11-20" }, new Date("2026-11-01T09:00:00"));

    const ana = r.usuarios.find((u) => u.clave === "ana");
    assert.equal(ana.completas, 3);
    assert.equal(ana.lineas, 40);
    assert.equal(ana.minutos, 90);                      // la de 24 h no suma tiempo
    assert.equal(Math.round(ana.lineasPorHora), 27);    // 40 líneas / 1,5 h
    assert.equal(r.atipicas, 1);
    assert.equal(r.enEspera, 1);
    assert.equal(r.abiertas[0].esperaMin, 60);          // la abierta se ve aunque sea vieja
    assert.equal(resumirPicking([tarea({}), tarea({ ctst_name: "Reposicion" })], { tipo: "Reposicion" }).total.completas, 1);
});

test("cajas y estibas: pedido de la tarea, reparto por líneas y totales sin ajustes", () => {
    assert.equal(pedidoDeTarea({ ctsk_task_name: "WNW948 ANT CAMPIN 2026-11-25 PKGPISO-P1", crul_name: "PKGPISO-P1" }), "WNW948 ANT CAMPIN 2026-11-25");
    assert.equal(pedidoDeTarea({ ctsk_task_name: "994682  -  Santo Domingo", crul_name: null }), "994682");

    const pedidos = { "P1": { cajas: 300, estibas: 9 } };
    const r = resumirPicking([
        tarea({ ctsk_id: 1, ctsk_task_name: "P1 R1", crul_name: "R1", ctsk_lines: 10 }),
        tarea({ ctsk_id: 2, ctsk_task_name: "P1 R2", crul_name: "R2", ctsk_lines: 20, ctsk_task_user: "luis" }),
        tarea({ ctsk_id: 3, ctsk_task_name: "P1  -  Cliente", ctst_name: "Auditoria Picking", ctsk_task_user: "eva" })
    ], {}, new Date(), pedidos);
    const u = (n) => r.usuarios.find((x) => x.clave === n);
    assert.equal(u("ana").cajas, 100);
    assert.equal(u("luis").cajas, 200);
    assert.equal(u("luis").estibas, 6);
    assert.equal(u("eva").cajasAuditadas, 300);
    assert.equal(u("eva").cajas, 0);
    assert.equal(u("ana").cajasPorHora, 200);            // 100 cajas en 30 min

    const m = resumirMovimientos({ resumen: [
        { sentido: "salida", dia: "2026-11-20", bodega: "J3", documento: "Salida por Pedido Venta", cajas: 50, estibas: 2, otras: { UND: 3 } },
        { sentido: "salida", dia: "2026-11-20", bodega: "J3", documento: "Salida por Ajuste de Inventario", cajas: 999, estibas: 9, otras: {} },
        { sentido: "entrada", dia: "2026-11-21", bodega: "MQ", documento: "Entrada por Traslado", cajas: 40, estibas: 1, otras: {} }
    ] }, { bodega: "J3" });
    assert.equal(m.total.salida.cajas, 50);
    assert.equal(m.total.entrada.cajas, 0);
    assert.equal(m.documentos.length, 2);
});

import { leerPlanilla, resumirPlanilla, conciliar, leerFecha, leerOperacion } from "../../shared/services/controlMuelles.js";

test("planilla Control Muelles: fechas a mano, operación, tiempos y conciliación", () => {
    assert.equal(leerFecha("17/11//2026"), "2026-11-17");
    assert.equal(leerFecha("20/112026"), "2026-11-20");
    assert.equal(leerFecha(new Date(1900, 0, 12)), null);
    assert.equal(leerOperacion("GARGUE"), "Cargue");
    assert.equal(leerOperacion("DESCRAGUE "), "Descargue");

    const h = (hh, mm) => new Date(1899, 11, 30, hh, mm);
    const { registros, descartadas } = leerPlanilla([
        ["Control"],
        ["FECHA", "MUELLE", "PLACA", " LLEGADA", " SALIDA", "TOTAL", "CARGUE /DESCARGUE", "REPORTA ", "RESPONSABLE INFO", "DESCRIPCION", "ESTIBAS", "CAJAS"],
        [new Date(2026, 9, 1), 3, "S78003", h(0, 2), h(0, 29), null, "DESCARGUE", "GIOVANNI FORERO", "JIMENA HERRERA", "ESTIBAS", 30, null],
        [new Date(2026, 9, 1), 3, "ABC123", h(23, 30), h(0, 30), null, "CARGUE  ", "giovanni  forero", "JIMENA HERRERA", "CAJAS", null, 500],
        [new Date(2026, 9, 2), 1, "XYZ999", h(1, 0), h(20, 0), null, "CARGUE", "ANA", "EDNA", "CAJAS", 2, 100],
        ["xx", 1, "MAL", null, null, null, "CARGUE", "ANA", "EDNA", "CAJAS", 0, 0],
        [null, null, null]
    ]);
    assert.equal(registros.length, 3);
    assert.equal(descartadas.length, 1);
    assert.equal(registros[0].minutos, 27);
    assert.equal(registros[1].minutos, 60);                 // pasó la medianoche
    assert.equal(registros[2].atipico, true);               // 19 h: no entra en tiempos

    const r = resumirPlanilla(registros, { desde: "2026-10-01", hasta: "2026-10-31" });
    const gio = r.reporta.find((x) => x.clave === "GIOVANNI FORERO");
    assert.equal(gio.vehiculos, 2);
    assert.equal(gio.cajas, 500);
    assert.equal(gio.estibas, 30);
    assert.equal(r.total.atipicos, 1);
    assert.equal(r.total.promedioMin, 43.5);

    const c = conciliar(registros, { resumen: [
        { sentido: "salida", dia: "2026-10-01", bodega: "J3", documento: "Salida por Pedido Venta", cajas: 480, estibas: 1 },
        { sentido: "salida", dia: "2026-10-01", bodega: "MQ", documento: "Salida por Pedido Venta", cajas: 999, estibas: 1 }
    ] }, { bodega: "J3" });
    assert.equal(c[0].planillaCargue, 500);
    assert.equal(c[0].wmsDespachado, 480);
});
