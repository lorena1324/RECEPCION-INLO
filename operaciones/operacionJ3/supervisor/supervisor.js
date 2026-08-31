/* ============================================================
   supervisor.js — Portería J3 · Rol Supervisor
   Escrito desde cero como módulo ES, consumiendo directamente
   shared/core/guard.js y shared/services/{vehiculos,eventos}.js.
   Solo lectura, salvo dos excepciones: el supervisor puede fijar
   el % de avance de cargue/descargue de cada muelle ocupado
   (actualizarAvance), y autorizar la salida anticipada de un
   vehículo en Cargue que no llegó al 100% pero sí al 75%
   (autorizarSalidaAnticipada). No importa nada de crearRegistro,
   actualizarUbicacion, registrarSalida ni eliminarRegistro.
   ============================================================ */

import { protegerPagina } from "../../../shared/core/guard.js";
import { cerrarSesionFirebase } from "../../../shared/core/auth.js";
import { cerrarSesionLocal } from "../../../shared/core/session.js";

import {
  suscribirseARegistros,
  getRegistrosEnPatio,
  getRegistrosEnMuelle,
  getMuellesOcupacion,
  actualizarAvance,
  avanzarAFaseCargue,
  autorizarSalidaAnticipada,
  puedeAutorizarSalidaAnticipada,
  requiereAvanceCompleto,
  avanceCompleto
} from "../../../shared/services/vehiculos.js";

import {
  getDestino,
  getDiaOperativo,
  getHistorial,
  getLocationDurations,
  minutosEsperando,
  nivelPrioridad,
  ordenarPorPrioridad,
  diaConMasMovimiento,
  tituloHistorial
} from "../../../shared/services/eventos.js";

import { todayOperativo, diaOperativo } from "../../../shared/utils/tiempos.js";

const OPERACION = "J3";
const NUM_MUELLES = 8;
const RUTA_LOGIN = "../../../index.html";

// J3 (Pepsico): el "día" del turno va de 6am a 6am, no de
// medianoche a medianoche. Ver shared/utils/tiempos.js.
const HORA_CORTE = 6;

// chartjs-plugin-datalabels ya viene cargado desde el <head>. Se
// registra una vez, deshabilitado por defecto: cada gráfica lo
// activa explícitamente en su config (options.plugins.datalabels).
if (typeof Chart !== "undefined" && typeof ChartDataLabels !== "undefined") {
  Chart.register(ChartDataLabels);
  Chart.defaults.set("plugins.datalabels", { display: false });
}

const ESTAD_COLORS = {
  azul: "#2563eb", azulClaro: "#93c5fd",
  verde: "#10b981", verdeClaro: "#bbf7d0",
  ambar: "#f59e0b", ambarClaro: "#fde68a",
  teal: "#0d9488", tealClaro: "#99f6e4",
  gris: "#9ca3af"
};

let estadPeriodoActual = "hoy";

let registros = [];
let canalFiltro = ""; // "" = todos, "MQ", "3PD" — filtro global (Dashboard + Registros + Estadísticas)
let unsubscribe = null;
let perfilActual = null;

// guard.js no expone una función de logout, así que la armamos aquí
// con las mismas piezas que usa internamente (auth.js + session.js).
function salir() {
  cerrarSesionFirebase()
    .catch(() => {})
    .finally(() => {
      cerrarSesionLocal();
      window.location.href = RUTA_LOGIN;
    });
}

/* =========================================================
   ARRANQUE: guard primero, datos después

   protegerPagina() RECHAZA la promesa (no se queda colgada) si
   no hay sesión válida, y ya se encarga de redirigir sola — por
   eso el .catch() de abajo no necesita hacer nada más.
   ========================================================= */

protegerPagina({ rolesPermitidos: ["supervisor"], operacion: OPERACION }).then((perfil) => {

  perfilActual = perfil;

  document.getElementById("nombre-usuario").textContent = perfil.nombre || perfil.uid;
  document.getElementById("btn-cerrar-sesion").addEventListener("click", salir);

  document.body.classList.remove("cargando");

  iniciarNavegacion();
  iniciarFiltros();
  iniciarExportar();
  iniciarPeriodoEstadisticas();
  iniciarAvanceClicks();

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
  // protegerPagina() ya redirigió a RUTA_LOGIN por su cuenta, pero
  // nos deja saber por qué antes de irse — muy útil mientras se
  // depura el perfil en Firestore.
  console.warn("[supervisor] Acceso rechazado por guard.js:", err && err.message);

  // TEMPORAL — quítalo cuando ya no lo necesites. alert() bloquea la
  // navegación un instante y se ve SIEMPRE, sin depender de F12.
  alert("Acceso rechazado por guard.js: " + (err && err.message));
});

window.addEventListener("beforeunload", () => {
  if (unsubscribe) unsubscribe();
});

// Refresco automático cada minuto, sin excepciones — aunque no haya
// llegado ningún cambio nuevo por Firestore, esto recalcula todo
// (KPIs, día con más movimiento, franja horaria, etc.) porque solo
// el paso del tiempo puede cambiar esos resultados.
setInterval(renderTodo, 60000);

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
   FILTRO DE CANAL (global: Dashboard + Registros + Estadísticas)
   ========================================================= */

function registrosFiltrados() {
  if (!canalFiltro) return registros;
  return registros.filter((r) => (r.canal || "") === canalFiltro);
}

/* =========================================================
   NAVEGACIÓN ENTRE VISTAS
   ========================================================= */

function iniciarNavegacion() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => mostrarVista(btn.dataset.view));
  });
}

function mostrarVista(nombre) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === nombre));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + nombre));

  const titulos = {
    dashboard: "Dashboard",
    registros: "Registros",
    estadisticas: "Estadísticas",
    exportar: "Exportar"
  };
  document.getElementById("titulo-vista").textContent = titulos[nombre] || nombre;

  if (nombre === "estadisticas") renderEstadisticas();
}

/* =========================================================
   RENDER GENERAL (se llama en cada actualización en vivo)
   ========================================================= */

function renderTodo() {
  renderDashboard();
  renderUbicacion();
  renderRegistros();
  if (document.getElementById("view-estadisticas").classList.contains("active")) {
    renderEstadisticas();
  }
}

/* =========================================================
   DASHBOARD
   ========================================================= */

function renderDashboard() {
  const base = registrosFiltrados();
  const enPatio = getRegistrosEnPatio(base);
  const enMuelle = getRegistrosEnMuelle(base);
  const diaOp = todayOperativo(HORA_CORTE);
  const entradasHoy = base.filter((r) => getDiaOperativo(r, HORA_CORTE) === diaOp);
  const enAlerta = enPatio.filter((r) => nivelPrioridad(minutosEsperando(r)) === "alta");

  document.getElementById("kpi-patio").textContent = enPatio.length;
  document.getElementById("kpi-muelle").textContent = enMuelle.length;
  document.getElementById("kpi-hoy").textContent = entradasHoy.length;
  document.getElementById("kpi-alerta").textContent = enAlerta.length;

  const mejorDia = diaConMasMovimiento(base, HORA_CORTE);
  if (mejorDia) {
    document.getElementById("kpi-mejor-dia-fecha").textContent = formatearFechaCorta(mejorDia.dia);
    document.getElementById("kpi-mejor-dia-detalle").textContent =
      `${mejorDia.total} movimientos (${mejorDia.entradas} entradas · ${mejorDia.salidas} salidas)`;
  } else {
    document.getElementById("kpi-mejor-dia-fecha").textContent = "—";
    document.getElementById("kpi-mejor-dia-detalle").textContent = "Sin datos todavía";
  }

  const ultimos = ordenarPorPrioridad(base).slice(0, 15);
  const tbody = document.getElementById("tabla-dashboard-body");
  tbody.innerHTML = ultimos.map(filaTabla).join("") || filaVacia(6);

  renderChartFranjaHoraria("chart-franja-horaria-dashboard", entradasHoy);
}

/* =========================================================
   FRANJA HORARIA — compartida entre Dashboard y Estadísticas

   Misma construcción de datos y mismas opciones de Chart.js en
   los dos lugares (apiladas por canal: 3PD / MQ / Otros), para
   que la gráfica se vea y se comporte exactamente igual — solo
   cambia qué lista de registros se le pasa (hoy vs. el periodo
   elegido en Estadísticas).
   ========================================================= */

function datosFranjaHoraria(registros) {
  const porHora3PD = new Array(24).fill(0);
  const porHoraMQ = new Array(24).fill(0);
  const porHoraOtros = new Array(24).fill(0);

  registros.forEach((r) => {
    if (!r.horaEntrada) return;
    const h = new Date(r.horaEntrada).getHours();
    if (isNaN(h)) return;
    const canalUp = (r.canal || "").toUpperCase();
    if (canalUp.indexOf("3PD") !== -1) porHora3PD[h]++;
    else if (canalUp === "MQ") porHoraMQ[h]++;
    else porHoraOtros[h]++;
  });

  const labels = [];
  const franja3PD = [], franjaMQ = [], franjaOtros = [];
  for (let i = 0; i < 24; i++) {
    const h = (HORA_CORTE + i) % 24;
    labels.push((h < 10 ? "0" : "") + h + "h");
    franja3PD.push(porHora3PD[h]);
    franjaMQ.push(porHoraMQ[h]);
    franjaOtros.push(porHoraOtros[h]);
  }

  const datasets = [
    { label: "3PD", data: franja3PD, backgroundColor: ESTAD_COLORS.azulClaro, borderColor: ESTAD_COLORS.azul, borderWidth: 1, borderRadius: 4, stack: "franja" },
    { label: "MQ", data: franjaMQ, backgroundColor: ESTAD_COLORS.tealClaro, borderColor: ESTAD_COLORS.teal, borderWidth: 1, borderRadius: 4, stack: "franja" }
  ];
  if (franjaOtros.some((v) => v > 0)) {
    datasets.push({ label: "Otros", data: franjaOtros, backgroundColor: ESTAD_COLORS.gris, borderRadius: 4, stack: "franja" });
  }

  return { labels, datasets };
}

function renderChartFranjaHoraria(canvasId, registros) {
  if (typeof Chart === "undefined") return;
  const { labels, datasets } = datosFranjaHoraria(registros);

  renderChart(canvasId, {
    type: "bar",
    data: { labels, datasets },
    options: {
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } },
        datalabels: { display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0, anchor: "center", align: "center", color: "#2B2B29", font: { size: 9, weight: "600" }, formatter: (v) => v }
      },
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}

function filaTabla(r) {
  const activo = !r.horaSalida;
  const min = minutosEsperando(r);
  const nivel = activo ? nivelPrioridad(min) : "normal";

  return `
    <tr>
      <td><strong>${escapar(r.placa)}</strong></td>
      <td>${escapar(r.conductor || "—")}</td>
      <td>${formatearFecha(r.horaEntrada)}</td>
      <td>${escapar(getDestino(r))}</td>
      <td>${activo ? formatearMinutos(min) : "—"}</td>
      <td>${activo
        ? `<span class="badge badge-prioridad-${nivel}">${nivel === "alta" ? "Urgente" : nivel === "media" ? "Atención" : "Normal"}</span>`
        : `<span class="badge badge-online">Finalizado</span>`}
      </td>
    </tr>`;
}

function filaVacia(cols) {
  return `<tr><td colspan="${cols}" style="text-align:center;color:#9ca3af;padding:20px;">Sin registros por ahora</td></tr>`;
}

/* =========================================================
   UBICACIÓN EN VIVO — tablero de 8 muelles + patio

   La tarjeta de cada muelle es idéntica a la que ve el operador
   (mismas clases: muelle-card/-top/-num/-status/-body/-placa/
   -empty, ver operador.js y css/components.css), sin los botones
   de Mover/Salida — el supervisor solo agrega el % de avance.
   ========================================================= */

function renderUbicacion() {
  const base = registrosFiltrados();
  const enMuelle = getRegistrosEnMuelle(base);
  const ocupacion = getMuellesOcupacion(enMuelle, NUM_MUELLES);

  const grid = document.getElementById("grid-muelles");
  let html = "";

  for (let n = 1; n <= NUM_MUELLES; n++) {
    const r = ocupacion[n];

    html += `
      <div class="muelle-card ${r ? "ocupado" : "libre"}">
        <div class="muelle-card-top">
          <span class="muelle-card-num">Muelle ${n}</span>
          <span class="muelle-card-status ${r ? "ocupado" : "libre"}">${r ? "OCUPADO" : "LIBRE"}</span>
        </div>
        <div class="muelle-card-body">
          ${r
            ? `<div class="muelle-card-placa">${escapar(r.placa)}</div><div>${escapar(r.conductor || "—")}</div>` +
              `<div style="margin-top:4px;"><span class="badge badge-canal">${escapar(r.canal || "—")}</span></div>${renderAvance(r)}` +
              `<div style="margin-top:6px;"><button class="btn btn-sm" data-novedades="${r.id}"><i class="ti ti-info-circle"></i> Novedades</button></div>`
            : `<div class="muelle-card-empty">Disponible</div>`}
        </div>
      </div>`;
  }

  grid.innerHTML = html;

  const enPatio = ordenarPorPrioridad(getRegistrosEnPatio(base));
  document.getElementById("tabla-patio-body").innerHTML = enPatio.map(filaPatio).join("") || filaVacia(8);
}

function claseTipo(tipo) {
  return tipo === "Cargue" ? "badge-cargue" : tipo === "Descargue" ? "badge-descargue" : "badge-ambos";
}

function filaPatio(r) {
  const min = minutosEsperando(r);
  const nivel = nivelPrioridad(min);
  return `
    <tr>
      <td><strong>${escapar(r.placa)}</strong></td>
      <td>${escapar(r.conductor || "—")}</td>
      <td><span class="badge ${claseTipo(r.tipo)}">${escapar(r.tipo || "—")}</span></td>
      <td><span class="badge badge-canal">${escapar(r.canal || "—")}</span></td>
      <td>${formatearFecha(r.horaEntrada)}</td>
      <td><span class="badge badge-prioridad-${nivel}">${formatearMinutos(min)}</span></td>
      <td>${escapar(r.operadorEntrada || "—")}</td>
      <td><button class="btn btn-sm" data-novedades="${r.id}"><i class="ti ti-info-circle"></i></button></td>
    </tr>`;
}

/* =========================================================
   AVANCE DE CARGUE/DESCARGUE (dentro de la tarjeta de muelle)

   Si el vehículo es "Ambos" (cargue y descargue), el supervisor
   primero elige cuál de los dos está midiendo — una vez elegido
   queda fijo (avanceTipo). Si el tipo ya es uno solo, no hace
   falta elegir: avanceTipo se fija desde la entrada en
   crearRegistro(). El porcentaje nunca pasa de 100: los botones
   se deshabilitan al llegar ahí y actualizarAvance() también lo
   recorta por seguridad.
   ========================================================= */

function getAvanceTipoEfectivo(r) {
  if (r.avanceTipo) return r.avanceTipo;
  if (r.tipo === "Cargue" || r.tipo === "Descargue") return r.tipo;
  return null;
}

function renderAvance(r) {
  const avanceTipo = getAvanceTipoEfectivo(r);

  if (!avanceTipo) {
    return `
      <div class="avance-selector">
        <span class="avance-label">¿Cargue o descargue?</span>
        <div class="avance-selector-btns">
          <button class="btn btn-sm btn-primary" data-avance-tipo="${r.id}:Cargue">Cargue</button>
          <button class="btn btn-sm btn-primary" data-avance-tipo="${r.id}:Descargue">Descargue</button>
        </div>
      </div>`;
  }

  const pct = r.avancePorcentaje || 0;
  const claseBadge = avanceTipo === "Cargue" ? "badge-cargue" : "badge-descargue";
  const deshabilitado = pct >= 100 ? "disabled" : "";

  let aviso = "";
  if (puedeAutorizarSalidaAnticipada(r) && !(r.autorizacionSalida && r.autorizacionSalida.motivo)) {
    aviso = `<div style="margin-top:4px;font-size:11px;color:#854F0B;"><i class="ti ti-alert-triangle"></i> Requiere autorización para salir — ver Novedades</div>`;
  } else if (r.autorizacionSalida && r.autorizacionSalida.motivo && pct < 100) {
    aviso = `<div style="margin-top:4px;font-size:11px;color:#3B6D11;"><i class="ti ti-shield-check"></i> Salida anticipada autorizada</div>`;
  }

  return `
    <div class="avance-box">
      <div class="avance-info">
        <span class="badge ${claseBadge}">${avanceTipo}</span>
        <span class="avance-pct">${pct}%</span>
      </div>
      <div class="avance-bar"><div class="avance-bar-fill" style="width:${pct}%"></div></div>
      <div class="avance-btns">
        <button class="btn btn-sm" data-avance-add="${r.id}:5" ${deshabilitado}>+5%</button>
        <button class="btn btn-sm" data-avance-add="${r.id}:10" ${deshabilitado}>+10%</button>
      </div>
      ${aviso}
    </div>`;
}

function iniciarAvanceClicks() {
  document.body.addEventListener("click", (e) => {
    const btnTipo = e.target.closest("[data-avance-tipo]");
    if (btnTipo) {
      const [id, tipo] = btnTipo.getAttribute("data-avance-tipo").split(":");
      seleccionarAvanceTipo(id, tipo);
      return;
    }

    const btnAdd = e.target.closest("[data-avance-add]");
    if (btnAdd) {
      const [id, delta] = btnAdd.getAttribute("data-avance-add").split(":");
      incrementarAvance(id, Number(delta));
      return;
    }

    const btnNovedades = e.target.closest("[data-novedades]");
    if (btnNovedades) {
      openModalNovedades(btnNovedades.getAttribute("data-novedades"));
      return;
    }

    const btnClose = e.target.closest("[data-close]");
    if (btnClose) {
      closeModal(btnClose.getAttribute("data-close"));
      return;
    }

    const btnAutorizar = e.target.closest("[data-autorizar-salida]");
    if (btnAutorizar) {
      autorizarSalida(btnAutorizar.getAttribute("data-autorizar-salida"));
    }
  });
}

function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}

/* =========================================================
   NOVEDADES DEL VEHÍCULO (historial completo, solo lectura)
   ========================================================= */

function openModalNovedades(id) {
  const rec = registros.find((r) => r.id === id);
  if (!rec) return;

  const hist = getHistorial(rec).slice().sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  const histHtml = !hist.length
    ? '<p style="color:#9ca3af;font-size:12.5px;">Sin novedades registradas.</p>'
    : hist.map((h) => `
        <div class="historial-item">
          <div class="historial-ico"><i class="ti ti-activity"></i></div>
          <div class="historial-body">
            <div class="historial-top"><strong>${escapar(tituloHistorial(h))}</strong><span class="historial-fecha">${formatearFecha(h.fecha)}</span></div>
            <div style="font-size:11px;color:#9ca3af;">${escapar(h.operador || "—")}</div>
            ${h.texto ? `<div class="historial-texto">${escapar(h.texto)}</div>` : ""}
          </div>
        </div>`).join("");

  document.getElementById("modal-novedades-body").innerHTML = `
    <div class="detail-row"><span class="detail-lbl">Placa:</span><span class="detail-val">${escapar(rec.placa)}</span></div>
    <div class="detail-row"><span class="detail-lbl">Conductor:</span><span class="detail-val">${escapar(rec.conductor || "—")}</span></div>
    <div class="detail-row"><span class="detail-lbl">Ubicación:</span><span class="detail-val">${escapar(getDestino(rec))}</span></div>
    <div class="detail-row"><span class="detail-lbl">Ingreso:</span><span class="detail-val">${formatearFecha(rec.horaEntrada)}</span></div>
    ${seccionAutorizacion(rec)}
    <div class="detail-section-title">Novedades</div>${histHtml}`;

  document.getElementById("modal-novedades").classList.add("open");
}

/* =========================================================
   AUTORIZACIÓN DE SALIDA ANTICIPADA (solo Cargue, mínimo 75%)

   Reglas de negocio: en Descargue no hay excepción posible (debe
   llegar al 100%). En Cargue, por debajo del 75% tampoco hay
   excepción — recién entre 75% y 99% el supervisor puede
   autorizar la salida explicando el motivo, que queda grabado
   en el historial del vehículo.
   ========================================================= */

function seccionAutorizacion(r) {
  if (r.horaSalida) return "";
  if (!requiereAvanceCompleto(r) || avanceCompleto(r)) return "";

  const pct = r.avancePorcentaje || 0;

  if (r.avanceTipo !== "Cargue") {
    return `<div class="detail-section-title">Autorización de salida</div>
      <p style="font-size:12.5px;color:#9ca3af;">Este vehículo es de descargue (${pct}%) — debe llegar al 100% para poder salir, sin excepción.</p>`;
  }

  if (r.autorizacionSalida && r.autorizacionSalida.motivo) {
    return `<div class="detail-section-title">Autorización de salida</div>
      <p style="font-size:12.5px;">Autorizada por <strong>${escapar(r.autorizacionSalida.autorizadoPor)}</strong> el ${formatearFecha(r.autorizacionSalida.fecha)}, con ${r.autorizacionSalida.porcentajeAlAutorizar}% de cargue.<br>Motivo: ${escapar(r.autorizacionSalida.motivo)}</p>`;
  }

  if (pct < 75) {
    return `<div class="detail-section-title">Autorización de salida</div>
      <p style="font-size:12.5px;color:#9ca3af;">El cargue está en ${pct}% — debe llegar mínimo al 75% para poder autorizar una salida anticipada.</p>`;
  }

  return `<div class="detail-section-title">Autorización de salida</div>
    <p style="font-size:12.5px;color:#854F0B;">El cargue está en ${pct}% (no llegó al 100%). Puedes autorizar la salida anticipada explicando el motivo.</p>
    <textarea id="autorizacion-motivo" placeholder="Motivo de la salida anticipada..." style="width:100%;min-height:60px;margin-bottom:8px;"></textarea>
    <button class="btn btn-sm btn-primary" data-autorizar-salida="${r.id}"><i class="ti ti-shield-check"></i> Autorizar salida</button>`;
}

async function autorizarSalida(id) {
  const rec = registros.find((r) => r.id === id);
  if (!rec) return;

  const textarea = document.getElementById("autorizacion-motivo");
  const motivo = textarea ? textarea.value.trim() : "";

  if (!motivo) {
    alert("Debes explicar el motivo de la salida anticipada.");
    return;
  }

  try {
    await autorizarSalidaAnticipada(id, { motivo, porcentaje: rec.avancePorcentaje || 0 }, perfilActual.nombre);
    openModalNovedades(id);
  } catch (error) {
    console.error("Error al autorizar la salida:", error);
    alert("Error al autorizar la salida. Intenta de nuevo.");
  }
}

async function seleccionarAvanceTipo(id, tipo) {
  try {
    await actualizarAvance(id, { avanceTipo: tipo, porcentaje: 0 }, perfilActual.nombre);
  } catch (error) {
    console.error("Error al fijar el tipo de avance:", error);
    alert("No se pudo guardar el tipo de avance (" + tipo + "). " + (error && error.message ? error.message : "Intenta de nuevo."));
  }
}

async function incrementarAvance(id, delta) {
  const rec = registros.find((r) => r.id === id);
  if (!rec) return;

  const avanceTipo = getAvanceTipoEfectivo(rec);
  if (!avanceTipo) return;

  const actual = rec.avancePorcentaje || 0;
  if (actual >= 100) return;

  const nuevoPct = Math.min(100, actual + delta);

  try {
    await actualizarAvance(id, { avanceTipo, porcentaje: nuevoPct }, perfilActual.nombre);

    // "Ambos": el descargue siempre va primero. Al llegar al 100%
    // se pasa solo a Cargue — el supervisor no tiene que elegir
    // manualmente el segundo tramo. Si el vehículo ya traía cargue
    // pendiente (porque el operario le agregó el descargue después
    // de que ya había empezado a cargar), retoma justo ahí en vez
    // de reiniciar en 0%.
    if (rec.tipo === "Ambos" && avanceTipo === "Descargue" && nuevoPct >= 100) {
      await avanzarAFaseCargue(id, { porcentajeInicial: rec.avanceCarguePendiente || 0 }, perfilActual.nombre);
    }
  } catch (error) {
    console.error("Error al actualizar el avance:", error);
    alert("No se pudo guardar el avance. " + (error && error.message ? error.message : "Intenta de nuevo."));
  }
}

/* =========================================================
   REGISTROS (tabla completa + filtros)
   ========================================================= */

function iniciarFiltros() {
  ["f-placa", "f-estado", "f-fecha"].forEach((id) => {
    document.getElementById(id).addEventListener("input", renderRegistros);
    document.getElementById(id).addEventListener("change", renderRegistros);
  });
}

function renderRegistros() {
  const texto = (document.getElementById("f-placa").value || "").toLowerCase();
  const estado = document.getElementById("f-estado").value;
  const fecha = document.getElementById("f-fecha").value;

  let filtrados = registrosFiltrados().filter((r) => {
    if (texto && !((r.placa || "").toLowerCase().includes(texto) || (r.conductor || "").toLowerCase().includes(texto))) return false;
    if (estado === "activo" && r.horaSalida) return false;
    if (estado === "finalizado" && !r.horaSalida) return false;
    if (fecha && r.fecha !== fecha) return false;
    return true;
  });

  filtrados = ordenarPorPrioridad(filtrados);

  const tbody = document.getElementById("tabla-registros-body");
  let activeRank = 0;
  tbody.innerHTML = filtrados.map((r) => {
    if (!r.horaSalida) activeRank++;
    return filaRegistro(r, activeRank);
  }).join("") || filaVacia(16);
}

/* =========================================================
   Fila de la tabla "Registros" — misma información que ve el
   operario (prioridad, tiempos por ubicación, motivo de patio,
   servicio, programación, etc.), pero de solo lectura: en vez
   de botones de editar/mover/salida/eliminar, un botón de
   Novedades que abre el mismo historial que el de muelles/patio.
   ========================================================= */

function prioridadRegistro(r, rank) {
  if (r.horaSalida) return '<span class="badge badge-salio">—</span>';
  const min = minutosEsperando(r);
  const clase = min >= 240 ? "badge-amber" : min >= 120 ? "badge-descargue" : "badge-en-patio";
  return `<span class="badge ${clase}"><i class="ti ti-flag-3"></i> #${rank} · ${formatearMinutos(min)}</span>`;
}

function celdaMotivoPatio(r) {
  if (r.horaSalida || r.ubicacion !== "Patio") return '<span style="color:#9ca3af;">—</span>';
  if (!r.obsUbicacion) return '<span style="color:#b45309;">Sin registrar</span>';
  const texto = r.obsUbicacion.length > 30 ? r.obsUbicacion.slice(0, 30) + "…" : r.obsUbicacion;
  return `<span title="${escapar(r.obsUbicacion)}">${escapar(texto)}</span>`;
}

function filaRegistro(r, rank) {
  const dur = getLocationDurations(r);
  return `
    <tr>
      <td>${prioridadRegistro(r, rank)}</td>
      <td><strong>${escapar(r.placa)}</strong></td>
      <td>${escapar(r.conductor || "—")}</td>
      <td>${escapar(getDestino(r))}</td>
      <td><span class="badge ${claseTipo(r.tipo)}">${escapar(r.tipo || "—")}</span></td>
      <td><span class="badge badge-canal">${escapar(r.canal || "—")}</span></td>
      <td>${formatearFecha(r.horaEntrada)}</td>
      <td>${r.horaSalida ? formatearFecha(r.horaSalida) : "—"}</td>
      <td>${!r.horaSalida ? '<span class="badge badge-en-patio">Activo</span>' : '<span class="badge badge-salio">Salió</span>'}</td>
      <td>${r.programado ? "Programado" : "No programado"}</td>
      <td>${escapar(r.servicioTipo || "Normal")}</td>
      <td>${formatearMinutos(dur.patio)}</td>
      <td>${formatearMinutos(dur.muelle)}</td>
      <td>${celdaMotivoPatio(r)}</td>
      <td>${escapar(r.operadorEntrada || "—")}</td>
      <td><button class="btn btn-sm" data-novedades="${r.id}"><i class="ti ti-info-circle"></i></button></td>
    </tr>`;
}

/* =========================================================
   ESTADÍSTICAS (Chart.js + chartjs-plugin-datalabels)

   Portado de estadisticas.html (versión anterior), con dos
   cambios de fondo:
   1. Todo lo que antes agrupaba por día CALENDARIO ahora agrupa
      por día OPERATIVO (6am–6am) — ver getDiaOperativo/tiempos.js.
   2. Respeta el filtro de canal global (registrosFiltrados()).
   ========================================================= */

let charts = {};

function iniciarPeriodoEstadisticas() {
  document.querySelectorAll("#view-estadisticas .filter-pills .pill").forEach((btn) => {
    btn.addEventListener("click", () => setPeriodoEstadisticas(btn.dataset.periodo, btn));
  });
  document.getElementById("estad-aplicar-rango").addEventListener("click", renderEstadisticas);
}

function setPeriodoEstadisticas(p, btn) {
  estadPeriodoActual = p;
  document.querySelectorAll("#view-estadisticas .filter-pills .pill").forEach((el) => el.classList.remove("active"));
  if (btn) btn.classList.add("active");

  const custom = document.getElementById("estad-rango-custom");
  if (p === "personalizado") {
    custom.style.display = "flex";
    if (!document.getElementById("estad-hasta").value) {
      const hoyOp = todayOperativo(HORA_CORTE);
      document.getElementById("estad-hasta").value = hoyOp;
      document.getElementById("estad-desde").value = hoyOp;
    }
    return; // esperar a que el usuario pulse "Aplicar"
  }
  custom.style.display = "none";
  renderEstadisticas();
}

/*
   Devuelve la lista de días OPERATIVOS (strings 'YYYY-MM-DD',
   cada uno representa el turno que arrancó a las 6am de esa
   fecha) que caen dentro del periodo elegido. Tope de 60 para
   no saturar los gráficos.
*/
function getDiasOperativosDelPeriodo() {
  const hoyOp = todayOperativo(HORA_CORTE);

  if (estadPeriodoActual === "personalizado") {
    const desde = document.getElementById("estad-desde").value;
    const hasta = document.getElementById("estad-hasta").value;
    return buildDayRange(desde || hoyOp, hasta || hoyOp);
  }

  if (estadPeriodoActual === "todo") {
    const base = registrosFiltrados();
    const dias = new Set();
    base.forEach((r) => {
      const d = getDiaOperativo(r, HORA_CORTE);
      if (d) dias.add(d);
    });
    if (!dias.size) dias.add(hoyOp);
    return Array.from(dias).sort();
  }

  const nDias = estadPeriodoActual === "3dias" ? 3 : estadPeriodoActual === "semana" ? 7 : estadPeriodoActual === "mes" ? 30 : 1;
  const dias = [];
  const cur = new Date(hoyOp + "T00:00:00");
  for (let i = nDias - 1; i >= 0; i--) {
    const d = new Date(cur);
    d.setDate(d.getDate() - i);
    dias.push(d.toISOString().slice(0, 10));
  }
  return dias;
}

function buildDayRange(desde, hasta) {
  const dias = [];
  const cur = new Date(desde + "T00:00:00");
  const fin = new Date(hasta + "T00:00:00");
  let iter = 0;
  while (cur <= fin && iter < 60) {
    dias.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
    iter++;
  }
  return dias.length ? dias : [todayOperativo(HORA_CORTE)];
}

function fmtDiaCorto(diaOp) {
  return new Date(diaOp + "T00:00:00").toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit" });
}

function renderChart(canvasId, config) {
  const ctx = document.getElementById(canvasId);
  if (!ctx || typeof Chart === "undefined") return;
  destruirSiExiste(canvasId);
  charts[canvasId] = new Chart(ctx, config);
}

function destruirSiExiste(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function renderEstadisticas() {
  const base = registrosFiltrados();
  const dias = getDiasOperativosDelPeriodo();
  const diasSet = new Set(dias);
  const recs = base.filter((r) => diasSet.has(getDiaOperativo(r, HORA_CORTE)));

  /* ── Tarjetas resumen ── */
  const totalEntradas = recs.length;
  const totalSalidas = recs.filter((r) => !!r.horaSalida).length;
  const tiempos = recs.filter((r) => r.horaSalida).map((r) => getLocationDurations(r).patio || 0);
  const promedioMin = tiempos.length ? Math.round(tiempos.reduce((a, b) => a + b, 0) / tiempos.length) : 0;
  const cargues = recs.filter((r) => r.tipo === "Cargue" || r.tipo === "Ambos").length;

  document.getElementById("es-total").textContent = totalEntradas;
  document.getElementById("es-salidas").textContent = totalSalidas;
  document.getElementById("es-promedio").textContent = formatearMinutos(promedioMin);

  const tiemposMuelle = recs.filter((r) => r.horaSalida).map((r) => getLocationDurations(r).muelle || 0);
  const promedioMuelleMin = tiemposMuelle.length ? Math.round(tiemposMuelle.reduce((a, b) => a + b, 0) / tiemposMuelle.length) : 0;
  document.getElementById("es-promedio-muelle").textContent = formatearMinutos(promedioMuelleMin);
  document.getElementById("es-cargue-pct").textContent = totalEntradas ? Math.round((cargues / totalEntradas) * 100) + "%" : "0%";
  // General: NO depende del periodo ni del canal — todos los registros conocidos.
  document.getElementById("es-total-general").textContent = registros.length;

  const mejorDia = diaConMasMovimiento(base, HORA_CORTE);
  document.getElementById("es-pico").textContent = mejorDia ? `${fmtDiaCorto(mejorDia.dia)} (${mejorDia.total})` : "—";

  if (typeof Chart === "undefined") return; // las cards de arriba ya quedaron listas; las gráficas se reintentan solas cuando Chart.js cargue

  /* ── Entradas y salidas por día operativo (entradas divididas Patio/Muelle) ── */
  const salidasPorDia = dias.map((d) => base.filter((r) => r.horaSalida && diaOperativo(r.horaSalida, HORA_CORTE) === d).length);
  const entradasPatioPorDia = dias.map((d) => recs.filter((r) => getDiaOperativo(r, HORA_CORTE) === d && getDestino(r).indexOf("Muelle") !== 0).length);
  const entradasMuellePorDia = dias.map((d) => recs.filter((r) => getDiaOperativo(r, HORA_CORTE) === d && getDestino(r).indexOf("Muelle") === 0).length);

  renderChart("chart-entradas-dia", {
    type: "bar",
    data: {
      labels: dias.map(fmtDiaCorto),
      datasets: [
        { label: "Entradas — Patio", data: entradasPatioPorDia, backgroundColor: ESTAD_COLORS.azul, borderRadius: 4 },
        { label: "Entradas — Muelle", data: entradasMuellePorDia, backgroundColor: ESTAD_COLORS.azulClaro, borderRadius: 4 },
        { label: "Salidas", data: salidasPorDia, backgroundColor: ESTAD_COLORS.verde, borderRadius: 4 }
      ]
    },
    options: {
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } },
        datalabels: { display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0, anchor: "end", align: "top", offset: 2, color: "#3A3A38", font: { size: 10, weight: "600" }, formatter: (v) => v }
      },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });

  /* ── Franja horaria: misma función que la del Dashboard, ver arriba ── */
  renderChartFranjaHoraria("chart-franja-horaria", recs);

  /* ── Tipo de operación ── */
  const soloCargue = recs.filter((r) => r.tipo === "Cargue").length;
  const soloDescargue = recs.filter((r) => r.tipo === "Descargue").length;
  const ambos = recs.filter((r) => r.tipo === "Ambos").length;
  renderChart("chart-tipo", {
    type: "doughnut",
    data: { labels: ["Cargue", "Descargue", "Ambos"], datasets: [{ data: [soloCargue, soloDescargue, ambos], backgroundColor: [ESTAD_COLORS.azul, ESTAD_COLORS.ambar, ESTAD_COLORS.teal] }] },
    options: { plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } }, datalabels: { display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0, color: "#fff", font: { size: 11, weight: "700" }, formatter: (v) => v } } }
  });

  /* ── Por operador ── */
  const porOperador = {};
  recs.forEach((r) => { const op = r.operadorEntrada || "—"; porOperador[op] = (porOperador[op] || 0) + 1; });
  const opLabels = Object.keys(porOperador).sort((a, b) => porOperador[b] - porOperador[a]);
  renderChart("chart-operador", {
    type: "bar",
    data: { labels: opLabels, datasets: [{ label: "Vehículos atendidos", data: opLabels.map((k) => porOperador[k]), backgroundColor: ESTAD_COLORS.teal, borderRadius: 4 }] },
    options: { indexAxis: "y", plugins: { legend: { display: false }, datalabels: { display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0, anchor: "end", align: "right", color: "#3A3A38", font: { size: 10, weight: "600" }, formatter: (v) => v } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
  });

  /* ── Tiempo promedio en patio por día ── */
  const tiempoPorDia = dias.map((d) => {
    const recsDia = recs.filter((r) => r.horaSalida && getDiaOperativo(r, HORA_CORTE) === d);
    if (!recsDia.length) return 0;
    const tot = recsDia.reduce((a, r) => a + (getLocationDurations(r).patio || 0), 0);
    return Math.round(tot / recsDia.length);
  });
  renderChart("chart-tiempo-patio", {
    type: "line",
    data: { labels: dias.map(fmtDiaCorto), datasets: [{ label: "Minutos promedio", data: tiempoPorDia, borderColor: ESTAD_COLORS.ambar, backgroundColor: "rgba(245,158,11,0.15)", fill: true, tension: 0.3, pointRadius: 3 }] },
    options: { plugins: { legend: { display: false }, datalabels: { display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0, align: "top", color: "#854F0B", font: { size: 10, weight: "600" }, formatter: (v) => v } }, scales: { y: { beginAtZero: true } } }
  });

  /* ── Por canal ── */
  const porCanal = {};
  recs.forEach((r) => { const c = r.canal || "—"; porCanal[c] = (porCanal[c] || 0) + 1; });
  const canalLabels = Object.keys(porCanal);
  renderChart("chart-canal", {
    type: "bar",
    data: { labels: canalLabels, datasets: [{ label: "Vehículos", data: canalLabels.map((k) => porCanal[k]), backgroundColor: ESTAD_COLORS.azulClaro, borderRadius: 4 }] },
    options: { plugins: { legend: { display: false }, datalabels: { display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0, anchor: "end", align: "top", color: "#3A3A38", font: { size: 10, weight: "600" }, formatter: (v) => v } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });

  /* ── Muelles más usados (general, dentro del periodo) ── */
  const porMuelle = {};
  recs.forEach((r) => {
    const dest = getDestino(r);
    if (dest.indexOf("Muelle") !== 0) return;
    porMuelle[dest] = (porMuelle[dest] || 0) + 1;
  });
  const muelleLabels = Object.keys(porMuelle).sort((a, b) => porMuelle[b] - porMuelle[a]);
  renderChart("chart-muelles-general", {
    type: "bar",
    data: { labels: muelleLabels, datasets: [{ label: "Veces usado", data: muelleLabels.map((k) => porMuelle[k]), backgroundColor: ESTAD_COLORS.teal, borderRadius: 4 }] },
    options: { indexAxis: "y", plugins: { legend: { display: false }, datalabels: { display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0, anchor: "end", align: "right", color: "#3A3A38", font: { size: 10, weight: "600" }, formatter: (v) => v } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
  });

  /* ── Tiempo promedio en muelle por día ── */
  const muellePorDia = dias.map((d) => {
    const recsDia = recs.filter((r) => r.horaSalida && getDiaOperativo(r, HORA_CORTE) === d);
    if (!recsDia.length) return 0;
    const tot = recsDia.reduce((a, r) => a + (getLocationDurations(r).muelle || 0), 0);
    return Math.round(tot / recsDia.length);
  });
  renderChart("chart-tiempo-muelle", {
    type: "line",
    data: { labels: dias.map(fmtDiaCorto), datasets: [{ label: "Minutos promedio", data: muellePorDia, borderColor: ESTAD_COLORS.teal, backgroundColor: "rgba(13,148,136,0.15)", fill: true, tension: 0.3, pointRadius: 3 }] },
    options: { plugins: { legend: { display: false }, datalabels: { display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0, align: "top", color: "#0d5a52", font: { size: 10, weight: "600" }, formatter: (v) => v } }, scales: { y: { beginAtZero: true } } }
  });

  /* ── Tablas segmentadas: por canal, por tipo, muelles por operario ── */
  renderTablaPorCanal(recs, canalLabels);
  renderTablaPorTipo(recs);
  renderTablaMuellesPorOperario(recs);
}

function renderTablaPorCanal(recs, canalLabels) {
  const cont = document.getElementById("estad-por-canal-body");
  if (!canalLabels.length) {
    cont.innerHTML = '<div class="texto-ayuda">No hay datos para el periodo.</div>';
    return;
  }
  let html = '<table class="tabla"><thead><tr><th>Canal</th><th>Promedio patio</th><th># Vehículos</th></tr></thead><tbody>';
  canalLabels.forEach((k) => {
    const grupo = recs.filter((r) => (r.canal || "—") === k);
    const suma = grupo.reduce((acc, r) => acc + (getLocationDurations(r).patio || 0), 0);
    const prom = grupo.length ? Math.round(suma / grupo.length) : 0;
    html += `<tr><td>${escapar(k)}</td><td>${formatearMinutos(prom)}</td><td>${grupo.length}</td></tr>`;
  });
  html += "</tbody></table>";
  cont.innerHTML = html;
}

function renderTablaPorTipo(recs) {
  const cont = document.getElementById("estad-por-tipo-body");
  const tipos = ["Cargue", "Descargue", "Ambos"];
  let html = '<table class="tabla"><thead><tr><th>Tipo</th><th>Promedio patio</th><th>Promedio muelle</th><th># Vehículos</th></tr></thead><tbody>';
  tipos.forEach((t) => {
    const grupo = recs.filter((r) => r.tipo === t);
    const sumaP = grupo.reduce((acc, r) => acc + (getLocationDurations(r).patio || 0), 0);
    const sumaM = grupo.reduce((acc, r) => acc + (getLocationDurations(r).muelle || 0), 0);
    const promP = grupo.length ? Math.round(sumaP / grupo.length) : 0;
    const promM = grupo.length ? Math.round(sumaM / grupo.length) : 0;
    html += `<tr><td>${t}</td><td>${formatearMinutos(promP)}</td><td>${formatearMinutos(promM)}</td><td>${grupo.length}</td></tr>`;
  });
  html += "</tbody></table>";
  cont.innerHTML = html;
}

function renderTablaMuellesPorOperario(recs) {
  const cont = document.getElementById("estad-muelles-operario-body");
  const porOperarioMuelle = {};
  recs.forEach((r) => {
    const dest = getDestino(r);
    if (dest.indexOf("Muelle") !== 0) return;
    const op = r.operadorEntrada || "—";
    if (!porOperarioMuelle[op]) porOperarioMuelle[op] = {};
    porOperarioMuelle[op][dest] = (porOperarioMuelle[op][dest] || 0) + 1;
  });

  const operarios = Object.keys(porOperarioMuelle);
  if (!operarios.length) {
    cont.innerHTML = '<div class="texto-ayuda">No hay datos de muelle para el periodo.</div>';
    return;
  }

  operarios.sort((a, b) => {
    const totalA = Object.values(porOperarioMuelle[a]).reduce((s, v) => s + v, 0);
    const totalB = Object.values(porOperarioMuelle[b]).reduce((s, v) => s + v, 0);
    return totalB - totalA;
  });

  let html = '<table class="tabla"><thead><tr><th>Operario</th><th>Muelle más usado</th><th>Veces</th><th>Total usos de muelle</th></tr></thead><tbody>';
  operarios.forEach((op) => {
    const muelles = porOperarioMuelle[op];
    const muelleKeys = Object.keys(muelles).sort((a, b) => muelles[b] - muelles[a]);
    const top = muelleKeys[0];
    const totalOp = muelleKeys.reduce((s, k) => s + muelles[k], 0);
    html += `<tr><td>${escapar(op)}</td><td>${escapar(top)}</td><td>${muelles[top]}</td><td>${totalOp}</td></tr>`;
  });
  html += "</tbody></table>";
  cont.innerHTML = html;
}


/* =========================================================
   EXPORTAR (XLSX directo — pendiente conectar con shared/utils/excel.js
   una vez se revise su contrato; por ahora autocontenido con la
   librería xlsx ya cargada en el <head>)
   ========================================================= */

function iniciarExportar() {
  document.getElementById("btn-exportar").addEventListener("click", exportar);
}

function exportar() {
  const desde = document.getElementById("exp-desde").value;
  const hasta = document.getElementById("exp-hasta").value;

  let filtrados = registros;
  if (desde) filtrados = filtrados.filter((r) => r.fecha >= desde);
  if (hasta) filtrados = filtrados.filter((r) => r.fecha <= hasta);

  const filas = filtrados.map((r) => ({
    Placa: r.placa,
    Conductor: r.conductor || "",
    Entrada: r.horaEntrada || "",
    Salida: r.horaSalida || "",
    Ubicacion: getDestino(r),
    Tipo: r.tipo || "",
    Operador_Entrada: r.operadorEntrada || "",
    Operador_Salida: r.operadorSalida || ""
  }));

  const hoja = XLSX.utils.json_to_sheet(filas);
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "Registros J3");
  XLSX.writeFile(libro, `registros_J3_${desde || "todo"}_a_${hasta || "hoy"}.xlsx`);
}

/* =========================================================
   UTILIDADES DE FORMATO
   ========================================================= */

function formatearFecha(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString("es-CO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatearFechaCorta(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" });
}

function formatearMinutos(min) {
  const m = Math.round(min);
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

function escapar(txt) {
  return String(txt == null ? "" : txt).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}