/* Reglas puras de integridad, con el reloj inyectado (deterministas).
   Correr:  node --test pruebas/integridad/integridad.test.js */

import test from "node:test";
import assert from "node:assert/strict";

import {
    ErrorIntegridad, TOPE_SALTO_AVANCE, TOPE_TANDA, VENTANA_TANDA_MIN,
    claveDePlaca, errorDuplicado, errorYaSalio, idCandado, validarAvance
} from "../../shared/services/integridad.js";

const AHORA = new Date("2026-10-19T12:00:00");
// "AAAA-MM-DDTHH:MM" en hora LOCAL, igual que nowLocal() de la aplicación (las fechas del
// historial no llevan zona: se leen como hora local).
const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const hace = (min) => local(new Date(AHORA.getTime() - min * 60000));
const sube = (min, anterior, porcentaje, tipo = "Descargue") => ({ fecha: hace(min), tipo: "avance", avanceTipo: tipo, anterior, porcentaje });

test("las placas se comparan sin espacios, signos ni mayúsculas", () => {
    assert.equal(claveDePlaca("SVD 390"), "SVD390");
    assert.equal(claveDePlaca(" svd-390 "), "SVD390");
    assert.equal(claveDePlaca(undefined), "");
    assert.equal(idCandado("J3", "svd 390"), "J3_SVD390");
    assert.notEqual(idCandado("J3", "SVD390"), idCandado("J4", "SVD390"));          // una por bodega
});

test("bajar o repetir el avance siempre se puede", () => {
    assert.equal(validarAvance({ actual: 50, nuevo: 20, ahora: AHORA }), null);
    assert.equal(validarAvance({ actual: 50, nuevo: 50, ahora: AHORA }), null);
});

test("una subida normal se acepta", () => {
    assert.equal(validarAvance({ actual: 40, nuevo: 50, historial: [], ahora: AHORA }), null);
});

test("subir más del tope en UNA solicitud se rechaza", () => {
    const e = validarAvance({ actual: 0, nuevo: TOPE_SALTO_AVANCE + 1, historial: [], ahora: AHORA });
    assert.ok(e instanceof ErrorIntegridad);
    assert.equal(e.codigo, "AVANCE_SALTO");
    assert.equal(validarAvance({ actual: 0, nuevo: 100, historial: [], ahora: AHORA }).codigo, "AVANCE_SALTO");
    assert.equal(validarAvance({ actual: 0, nuevo: TOPE_SALTO_AVANCE, historial: [], ahora: AHORA }), null);   // justo el tope: se puede
});

test("la tanda suma las subidas recientes: a base de +10 se frena", () => {
    // 0→10, 10→20, 20→30 en el último minuto; un +10 más daría 40 en la tanda (tope 30)
    const historial = [sube(1, 0, 10), sube(1, 10, 20), sube(0, 20, 30)];
    const e = validarAvance({ actual: 30, nuevo: 40, historial, avanceTipo: "Descargue", ahora: AHORA });
    assert.equal(e.codigo, "AVANCE_TANDA");
    assert.equal(e.detalle.enTanda, 40);
});

test("lo de HACE RATO ya no cuenta: pasada la ventana se puede seguir", () => {
    const viejo = [sube(VENTANA_TANDA_MIN + 3, 0, 10), sube(VENTANA_TANDA_MIN + 2, 10, 20), sube(VENTANA_TANDA_MIN + 1, 20, 30)];
    assert.equal(validarAvance({ actual: 30, nuevo: 40, historial: viejo, avanceTipo: "Descargue", ahora: AHORA }), null);
});

test("un ritmo que SÍ cabe en el tope de la tanda se acepta", () => {
    const historial = [sube(1, 0, 10), sube(0, 10, 20)];                       // 20 puntos en la ventana
    assert.equal(validarAvance({ actual: 20, nuevo: 30, historial, avanceTipo: "Descargue", ahora: AHORA }), null);   // 30 = tope: justo
    assert.equal(validarAvance({ actual: 20, nuevo: 31, historial, avanceTipo: "Descargue", ahora: AHORA }).codigo, "AVANCE_TANDA");
});

test("las subidas de OTRA fase no cuentan para la tanda", () => {
    const historial = [sube(0, 0, 25, "Cargue"), sube(0, 25, 50, "Cargue")];
    assert.equal(validarAvance({ actual: 0, nuevo: 20, historial, avanceTipo: "Descargue", ahora: AHORA }), null);
});

test("los eventos viejos sin `anterior` (antes de esta regla) no rompen nada", () => {
    const historial = [{ fecha: hace(0), tipo: "avance", texto: "Avance de Descargue actualizado a 50%" }];
    assert.equal(validarAvance({ actual: 50, nuevo: 60, historial, ahora: AHORA }), null);
});

test("bajar y volver a subir en la ventana: la tanda cuenta desde el punto más bajo", () => {
    const historial = [sube(1, 0, 25), sube(0, 25, 5)];                         // subió a 25 y bajó a 5
    const e = validarAvance({ actual: 5, nuevo: 25, historial, avanceTipo: "Descargue", ahora: AHORA });
    assert.equal(e, null);                                                      // 25 - 0 = 25 ≤ 30
    assert.equal(validarAvance({ actual: 5, nuevo: 31, historial, avanceTipo: "Descargue", ahora: AHORA }).codigo, "AVANCE_SALTO");
});

test("la excepción (backfill del administrador) se salta todo", () => {
    assert.equal(validarAvance({ actual: 0, nuevo: 100, historial: [], ahora: AHORA, excepcion: true }), null);
});

test("los mensajes dicen quién y cuándo", () => {
    const d = errorDuplicado({ id: "x", placa: "SVD 390", destino: "Muelle 3", operadorEntrada: "Ana", horaEntrada: "2026-10-19T14:05" });
    assert.match(d.message, /SVD 390/); assert.match(d.message, /Muelle 3/); assert.match(d.message, /Ana/); assert.match(d.message, /14:05/);
    assert.equal(d.codigo, "PLACA_DUPLICADA");

    const s = errorYaSalio({ operadorSalida: "Beto", horaSalida: "2026-10-19T15:30" }, "salida");
    assert.match(s.message, /Beto/); assert.match(s.message, /15:30/);
    assert.equal(errorYaSalio({ cancelado: true, operadorSalida: "Sup", horaSalida: "2026-10-19T15:30" }).message.includes("cancelado"), true);
});

test("sanidad de los números por defecto", () => {
    assert.ok(TOPE_TANDA >= TOPE_SALTO_AVANCE, "la tanda tiene que poder contener al menos una solicitud llena");
    assert.ok(VENTANA_TANDA_MIN > 0);
});
