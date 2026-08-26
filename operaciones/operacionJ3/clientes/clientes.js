/* ============================================================
   clientes.js — Portería J3 · Rol Cliente (Pepsico)
   Panel 100% estadístico, solo lectura. J3 es exclusiva de
   Pepsico (pendiente confirmación formal), así que NO se filtra
   por un campo "cliente" dentro del registro — todo lo que hay
   en la operación J3 pertenece a este cliente.

   Todo lo relacionado con "día" usa el día OPERATIVO (6am–6am),
   no el día calendario — igual que se corrigió en supervisor.js.
   ============================================================ */

import { protegerPagina } from "../../../shared/core/guard.js";
import { cerrarSesionFirebase } from "../../../shared/core/auth.js";
import { cerrarSesionLocal } from "../../../shared/core/session.js";

import { suscribirseARegistros, getRegistrosEnPatio, getRegistrosEnMuelle } from "../../../shared/services/vehiculos.js";

import {
  getDiaOperativo,
  getLocationDurations,
  minutosEsperando,
  nivelPrioridad,
  diaConMasMovimiento
} from "../../../shared/services/eventos.js";

import { todayOperativo } from "../../../shared/utils/tiempos.js";

const OPERACION = "J3";
const RUTA_LOGIN = "../../../index.html";

// J3 (Pepsico): el día del turno va de 6am a 6am, no de
// medianoche a medianoche. Ver shared/utils/tiempos.js.
const HORA_CORTE = 6;

let registros = [];
let canalFiltro = ""; // "" = todos, "MQ", "3PD"
let unsubscribe = null;
let chartTiposOperacion = null;
let chartFranjaHoraria = null;

function salir() {
  cerrarSesionFirebase()
    .catch(() => {})
    .finally(() => {
      cerrarSesionLocal();
      window.location.href = RUTA_LOGIN;
    });
}

/* =========================================================
   ARRANQUE
   ========================================================= */

protegerPagina({ rolesPermitidos: ["cliente"], operacion: OPERACION }).then((perfil) => {

  document.getElementById("nombre-usuario").textContent = perfil.nombre || perfil.uid;
  document.getElementById("btn-cerrar-sesion").addEventListener("click", salir);

  document.body.classList.remove("cargando");

  document.getElementById("filtro-canal").addEventListener("change", (e) => {
    canalFiltro = e.target.value;
    renderTodo();
  });

  unsubscribe = suscribirseARegistros(OPERACION, (data, error) => {
    if (error) {
      marcarDesconectado();
      return;
    }
    marcarConectado();
    registros = data || [];
    renderTodo();
  });

}).catch((err) => {
  // TEMPORAL — mismo mecanismo que en supervisor.js, quitar cuando
  // ya no se necesite depurar el perfil/rol en Firestore.
  console.warn("[clientes] Acceso rechazado por guard.js:", err && err.message);
  alert("Acceso rechazado por guard.js: " + (err && err.message));
});

window.addEventListener("beforeunload", () => {
  if (unsubscribe) unsubscribe();
});

function marcarConectado() {
  const b = document.getElementById("badge-conexion");
  b.className = "badge badge-online";
  b.innerHTML = '<i class="ti ti-plug-connected"></i> En vivo';
}

function marcarDesconectado() {
  const b = document.getElementById("badge-conexion");
  b.className = "badge badge-offline";
  b.innerHTML = '<i class="ti ti-plug-connected-x"></i> Sin conexión';
}

/* =========================================================
   FILTRO DE CANAL (aplica a todo el panel)
   ========================================================= */

function registrosFiltrados() {
  if (!canalFiltro) return registros;
  return registros.filter((r) => (r.canal || "") === canalFiltro);
}

/* =========================================================
   RENDER GENERAL
   ========================================================= */

function renderTodo() {
  renderResumen();
  renderTiposOperacion();
  renderFranjaHoraria();
}

/* =========================================================
   RESUMEN: día con más movimiento + KPIs generales
   ========================================================= */

function renderResumen() {
  const filtrados = registrosFiltrados();
  const diaOp = todayOperativo(HORA_CORTE);
  const deHoy = filtrados.filter((r) => getDiaOperativo(r, HORA_CORTE) === diaOp);

  // Cantidad de vehículos general — TODOS los registros, sin
  // filtrar por período (solo respeta el filtro de canal).
  document.getElementById("kpi-total-general").textContent = filtrados.length;
  document.getElementById("kpi-hoy").textContent = deHoy.length;

  const enPatio = getRegistrosEnPatio(filtrados);
  const enMuelle = getRegistrosEnMuelle(filtrados);
  document.getElementById("kpi-patio-actual").textContent = enPatio.length;
  document.getElementById("kpi-muelle-actual").textContent = enMuelle.length;

  const enAlerta = enPatio.filter((r) => nivelPrioridad(minutosEsperando(r)) === "alta");
  document.getElementById("kpi-alerta").textContent = enAlerta.length;

  // Día con más movimiento = entradas + salidas de ese día operativo,
  // sobre TODO el histórico disponible (no solo hoy).
  const mejorDia = diaConMasMovimiento(filtrados, HORA_CORTE);
  if (mejorDia) {
    document.getElementById("kpi-mejor-dia-fecha").textContent = formatearFechaCorta(mejorDia.dia);
    document.getElementById("kpi-mejor-dia-detalle").textContent =
      `${mejorDia.total} movimientos (${mejorDia.entradas} entradas · ${mejorDia.salidas} salidas)`;
  } else {
    document.getElementById("kpi-mejor-dia-fecha").textContent = "—";
    document.getElementById("kpi-mejor-dia-detalle").textContent = "Sin datos todavía";
  }

  renderPrioridades(enPatio);
}

function renderPrioridades(enPatio) {
  const conteo = { normal: 0, media: 0, alta: 0 };
  enPatio.forEach((r) => {
    conteo[nivelPrioridad(minutosEsperando(r))]++;
  });

  document.getElementById("prioridad-normal").textContent = conteo.normal;
  document.getElementById("prioridad-media").textContent = conteo.media;
  document.getElementById("prioridad-alta").textContent = conteo.alta;
}

/* =========================================================
   TIEMPOS DE CARGUE/DESCARGUE EN PATIO Y MUELLE
   (segmentado por tipo de operación, día operativo actual)
   ========================================================= */

function renderTiposOperacion() {
  if (typeof Chart === "undefined") return;

  const filtrados = registrosFiltrados();
  const diaOp = todayOperativo(HORA_CORTE);
  const deHoy = filtrados.filter((r) => getDiaOperativo(r, HORA_CORTE) === diaOp);

  const acumulado = {
    Cargue: { patio: 0, muelle: 0, n: 0 },
    Descargue: { patio: 0, muelle: 0, n: 0 }
  };

  deHoy.forEach((r) => {
    const tipoTexto = r.tipo || "";
    const d = getLocationDurations(r);
    // Un registro puede ser "ambos" (Cargue y Descargue a la vez);
    // en ese caso cuenta en las dos categorías.
    if (tipoTexto.indexOf("Cargue") !== -1) {
      acumulado.Cargue.patio += d.patio;
      acumulado.Cargue.muelle += d.muelle;
      acumulado.Cargue.n++;
    }
    if (tipoTexto.indexOf("Descargue") !== -1) {
      acumulado.Descargue.patio += d.patio;
      acumulado.Descargue.muelle += d.muelle;
      acumulado.Descargue.n++;
    }
  });

  const promedio = (obj, campo) => (obj.n ? Math.round(obj[campo] / obj.n) : 0);

  if (chartTiposOperacion) chartTiposOperacion.destroy();
  chartTiposOperacion = new Chart(document.getElementById("chart-tipos-operacion"), {
    type: "bar",
    data: {
      labels: ["Cargue", "Descargue"],
      datasets: [
        { label: "Patio (min prom.)", data: [promedio(acumulado.Cargue, "patio"), promedio(acumulado.Descargue, "patio")], backgroundColor: "#f59e0b" },
        { label: "Muelle (min prom.)", data: [promedio(acumulado.Cargue, "muelle"), promedio(acumulado.Descargue, "muelle")], backgroundColor: "#2563eb" }
      ]
    },
    options: { plugins: { legend: { position: "bottom" } } }
  });
}

/* =========================================================
   COMPORTAMIENTO EN FRANJA HORARIA (día operativo actual)
   ========================================================= */

function renderFranjaHoraria() {
  if (typeof Chart === "undefined") return;

  const filtrados = registrosFiltrados();
  const diaOp = todayOperativo(HORA_CORTE);
  const deHoy = filtrados.filter((r) => getDiaOperativo(r, HORA_CORTE) === diaOp);

  const cont = new Array(24).fill(0);
  deHoy.forEach((r) => {
    if (!r.horaEntrada) return;
    const h = new Date(r.horaEntrada).getHours();
    if (!isNaN(h)) cont[h]++;
  });

  // Mismo reordenamiento que en supervisor.js: el eje arranca en
  // HORA_CORTE (6am), no a medianoche.
  const labels = [];
  const valores = [];
  for (let i = 0; i < 24; i++) {
    const h = (HORA_CORTE + i) % 24;
    labels.push(h + "h");
    valores.push(cont[h]);
  }

  if (chartFranjaHoraria) chartFranjaHoraria.destroy();
  chartFranjaHoraria = new Chart(document.getElementById("chart-franja-horaria"), {
    type: "bar",
    data: { labels, datasets: [{ label: "Entradas", data: valores, backgroundColor: "#2563eb" }] },
    options: { plugins: { legend: { display: false } } }
  });
}

/* =========================================================
   UTILIDADES
   ========================================================= */

function formatearFechaCorta(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" });
}

