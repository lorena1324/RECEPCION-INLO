/* =========================================================
   INLOTRANS — Backfill de avance (herramienta de mantenimiento)

   Corrige el hueco descrito en shared/services/vehiculos.js
   (ver "REGLA: NO SALIR SIN COMPLETAR EL AVANCE"): los vehículos
   que ya estaban activos cuando se implementó esa regla nunca
   recibieron el campo `avancePorcentaje`, y quedan exentos de
   la regla para siempre porque `requiereAvanceCompleto()` solo
   exige el avance cuando el campo existe.

   Esta página busca esos vehículos (activos, sin `avancePorcentaje`)
   y les fija el avance en 0% usando la misma función que ya usa
   el supervisor (`actualizarAvance`) — no hay lógica nueva de
   escritura, solo se reutiliza la existente para que quede el
   mismo rastro en el historial de cada vehículo.

   Solo administrador: la colección "vehiculos" es compartida por
   todas las operaciones (J3/J4/B9) y esta herramienta no filtra
   por operación, así que no se habilita para supervisores.
   ========================================================= */

import { protegerPagina } from "../shared/core/guard.js";
import { cerrarSesionFirebase } from "../shared/core/auth.js";
import { cerrarSesionLocal } from "../shared/core/session.js";
import { db } from "../shared/core/firebase.js";

import {
    collection,
    query,
    where,
    getDocs
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { actualizarAvance, MINIMO_CARGUE_ANTICIPADO } from "../shared/services/vehiculos.js";

let perfilActual = null;
let pendientes = [];

protegerPagina({ rolesPermitidos: ["administrador"] })
    .then(function (perfil) {
        perfilActual = perfil;
        document.getElementById("nombre-usuario").textContent = perfil.nombre || perfil.uid;
        iniciarEventos();
    })
    .catch(function () {
        // protegerPagina ya redirigió a index.html
    });

function iniciarEventos() {
    // El umbral del texto explicativo también sale de la constante:
    // si mañana cambia, esta página no queda mintiendo.
    const spanMinimo = document.getElementById("minimo-cargue");
    if (spanMinimo) spanMinimo.textContent = MINIMO_CARGUE_ANTICIPADO;

    document.getElementById("btn-escanear").addEventListener("click", escanear);
    document.getElementById("btn-aplicar").addEventListener("click", aplicarBackfill);
    document.getElementById("btn-salir").addEventListener("click", async function () {
        await cerrarSesionFirebase();
        cerrarSesionLocal();
        window.location.href = "../index.html";
    });
}

function avanceTipoDestino(tipo) {
    return tipo === "Ambos" ? "Descargue" : tipo;
}

async function escanear() {
    const btn = document.getElementById("btn-escanear");
    btn.disabled = true;
    btn.innerHTML = "Escaneando...";

    try {
        const q = query(collection(db, "vehiculos"), where("horaSalida", "==", null));
        const snap = await getDocs(q);

        pendientes = [];
        snap.forEach(function (docSnap) {
            const data = docSnap.data();
            if (data.avancePorcentaje === undefined || data.avancePorcentaje === null) {
                pendientes.push(Object.assign({ id: docSnap.id }, data));
            }
        });

        renderResultado();
    } catch (error) {
        console.error("Error al escanear:", error);
        alert("Error al escanear: " + (error && error.message ? error.message : error));
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="ti ti-search"></i> Escanear de nuevo';
    }
}

function escapar(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderResultado() {
    const info = document.getElementById("resultado-info");
    const tbody = document.getElementById("tabla-pendientes");
    const btnAplicar = document.getElementById("btn-aplicar");

    if (!pendientes.length) {
        info.innerHTML = '<div class="modal-info-box" style="color:var(--green-600);"><i class="ti ti-circle-check"></i> No hay vehículos activos sin avance registrado. Nada que corregir.</div>';
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Sin pendientes.</td></tr>';
        btnAplicar.disabled = true;
        btnAplicar.textContent = "Aplicar backfill";
        return;
    }

    info.innerHTML = '<div class="modal-info-box" style="color:var(--amber-600);"><i class="ti ti-alert-triangle"></i> ' +
        pendientes.length + ' vehículo(s) activo(s) sin avance registrado — hoy pueden salir sin ninguna restricción de %. ' +
        'Se les fijará el avance en 0%.</div>';

    tbody.innerHTML = pendientes.map(function (r) {
        return '<tr>' +
            '<td>' + escapar(r.operacion || '—') + '</td>' +
            '<td class="td-placa">' + escapar(r.placa || '—') + '</td>' +
            '<td>' + escapar(r.conductor || '—') + '</td>' +
            '<td><span class="badge badge-cargue">' + escapar(r.tipo || '—') + '</span></td>' +
            '<td>' + escapar(r.horaEntrada || '—') + '</td>' +
            '<td>' + (avanceTipoDestino(r.tipo) ? '<strong>' + escapar(avanceTipoDestino(r.tipo)) + ' 0%</strong>' : '<span style="color:var(--red-600);">Sin "tipo" — requiere revisión manual</span>') + '</td>' +
            '</tr>';
    }).join("");

    btnAplicar.disabled = false;
    btnAplicar.textContent = "Aplicar backfill a " + pendientes.length + " vehículo(s)";
}

async function aplicarBackfill() {
    if (!pendientes.length) return;

    const confirmado = window.confirm(
        "Vas a fijar el avance en 0% para " + pendientes.length + " vehículo(s) activo(s) que hoy no tienen " +
        "ninguna restricción de salida. A partir de esto quedarán sujetos a la regla del 100% (o " +
        MINIMO_CARGUE_ANTICIPADO + "% + autorización, en Cargue). Esto escribe directamente en Firestore y no se puede deshacer automáticamente. " +
        "¿Continuar?"
    );
    if (!confirmado) return;

    const btn = document.getElementById("btn-aplicar");
    btn.disabled = true;

    const log = document.getElementById("log-resultado");
    log.innerHTML = "";

    const aplicados = pendientes;
    let exitosos = 0;
    let fallidos = 0;

    for (const r of aplicados) {
        const avanceTipo = avanceTipoDestino(r.tipo);

        if (!avanceTipo) {
            fallidos++;
            log.innerHTML += '<div style="color:var(--red-600);font-size:12.5px;"><i class="ti ti-x"></i> ' + escapar(r.placa || r.id) + ' — Omitido: no tiene campo "tipo" válido, requiere revisión manual.</div>';
            continue;
        }

        try {
            await actualizarAvance(
                r.id,
                { avanceTipo: avanceTipo, porcentaje: 0 },
                (perfilActual.nombre || perfilActual.uid) + " (backfill)"
            );
            exitosos++;
            log.innerHTML += '<div style="color:var(--green-600);font-size:12.5px;"><i class="ti ti-circle-check"></i> ' + escapar(r.placa) + ' — OK (' + escapar(avanceTipo) + ' 0%)</div>';
        } catch (error) {
            fallidos++;
            console.error("Error al aplicar backfill a " + r.id, error);
            log.innerHTML += '<div style="color:var(--red-600);font-size:12.5px;"><i class="ti ti-x"></i> ' + escapar(r.placa) + ' — Error: ' + escapar(error && error.message ? error.message : error) + '</div>';
        }
    }

    log.innerHTML += '<div style="margin-top:8px;font-weight:600;">Listo: ' + exitosos + ' actualizado(s), ' + fallidos + ' con error.</div>';

    pendientes = [];
    btn.textContent = "Aplicar backfill";

    document.getElementById("resultado-info").innerHTML =
        '<div class="modal-info-box" style="color:var(--green-600);"><i class="ti ti-circle-check"></i> Backfill aplicado. Vuelve a escanear si quieres confirmar que ya no quedan pendientes.</div>';
    document.getElementById("tabla-pendientes").innerHTML = '<tr><td colspan="6" class="empty-state">Vuelve a escanear para verificar.</td></tr>';
}
