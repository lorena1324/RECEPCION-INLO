/* Cálculos del apartado Picking (shared/services/picking.js). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resumirPicking, minutosDeTiempo, duracionDeTarea } from "../../shared/services/picking.js";

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
