/* ============================================================
   supervisor.js — Portería B9 · Rol Supervisor
   Escrito desde cero como módulo ES, consumiendo directamente
   shared/core/guard.js y shared/services/{vehiculos,eventos}.js.
   Solo lectura, salvo dos excepciones: el supervisor puede fijar
   el % de avance de cargue/descargue de cada muelle ocupado
   (actualizarAvance), y autorizar la salida anticipada de un
   vehículo en Cargue que no llegó al 100% pero sí al mínimo
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
  avanceCompleto,
  MINIMO_CARGUE_ANTICIPADO
} from "../../../shared/services/vehiculos.js";

import {
  canalDe,
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

import { todayOperativo, sumarDias } from "../../../shared/utils/tiempos.js";

import {
  renderPanelEstadisticas,
  renderChartFranjaHoraria
} from "../../../shared/services/estadisticas.js";

const OPERACION = "B9";
const NUM_MUELLES = 4;
const RUTA_LOGIN = "../../../index.html";

// B9 (EMMA): el "día" del turno va de 6am a 6am, no de
// medianoche a medianoche. Ver shared/utils/tiempos.js.
const HORA_CORTE = 6;

// chartjs-plugin-datalabels ya viene cargado desde el <head>. Se
// registra una vez, deshabilitado por defecto: cada gráfica lo
// activa explícitamente en su config (options.plugins.datalabels).
if (typeof Chart !== "undefined" && typeof ChartDataLabels !== "undefined") {
  Chart.register(ChartDataLabels);
  Chart.defaults.set("plugins.datalabels", { display: false });
}

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
  // canalDe() normaliza: los registros viejos que quedaron en
  // "Sin canal" cuentan como "Otro", que es la opción que hoy
  // ofrece el formulario.
  return registros.filter((r) => canalDe(r) === canalFiltro);
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
   UBICACIÓN EN VIVO — tablero de 4 muelles + patio

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
  if (!requiereAvanceCompleto(r)) {
    const aviso = `<div style="font-size:11.5px;color:#854F0B;"><i class="ti ti-alert-triangle"></i> Sin avance registrado (vehículo anterior a esta función) — puede salir sin restricción de %. Fija su avance para que la regla de avance empiece a aplicar.</div>`;

    const botones = (r.tipo === "Cargue" || r.tipo === "Descargue")
      ? `<button class="btn btn-sm btn-primary" data-avance-tipo="${r.id}:${r.tipo}">Fijar avance en 0% (${r.tipo})</button>`
      : `<button class="btn btn-sm btn-primary" data-avance-tipo="${r.id}:Cargue">Cargue</button>
         <button class="btn btn-sm btn-primary" data-avance-tipo="${r.id}:Descargue">Descargue</button>`;

    return `
      <div class="avance-box">
        ${aviso}
        <div class="avance-selector-btns" style="margin-top:6px;">${botones}</div>
      </div>`;
  }

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
        <button class="btn btn-sm" data-avance-add="${r.id}:1" ${deshabilitado}>+1%</button>
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
    <div class="detail-row"><span class="detail-lbl">Programado:</span><span class="detail-val">${rec.programado && rec.horaProgramacion ? formatearFecha(rec.horaProgramacion) : "No"}</span></div>
    ${seccionAutorizacion(rec)}
    <div class="detail-section-title">Novedades</div>${histHtml}`;

  document.getElementById("modal-novedades").classList.add("open");
}

/* =========================================================
   AUTORIZACIÓN DE SALIDA ANTICIPADA (solo Cargue)

   Reglas de negocio: en Descargue no hay excepción posible (debe
   llegar al 100%). En Cargue, por debajo de
   MINIMO_CARGUE_ANTICIPADO tampoco hay excepción — recién entre
   ese mínimo y el 99% el supervisor puede autorizar la salida
   explicando el motivo, que queda grabado en el historial del
   vehículo. El umbral vive en shared/services/vehiculos.js; aquí
   no se escribe el número, se importa.
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

  if (pct < MINIMO_CARGUE_ANTICIPADO) {
    return `<div class="detail-section-title">Autorización de salida</div>
      <p style="font-size:12.5px;color:#9ca3af;">El cargue está en ${pct}% — debe llegar mínimo al ${MINIMO_CARGUE_ANTICIPADO}% para poder autorizar una salida anticipada (faltan ${MINIMO_CARGUE_ANTICIPADO - pct} puntos).</p>`;
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
  }).join("") || filaVacia(17);
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

function badgeEstado(r) {
  if (r.horaSalida) return '<span class="badge badge-salio">Salió</span>';
  if (!requiereAvanceCompleto(r)) {
    return '<span class="badge badge-amber" title="Sin avance registrado — puede salir sin restricción de %"><i class="ti ti-alert-triangle"></i> Activo</span>';
  }
  return '<span class="badge badge-en-patio">Activo</span>';
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
      <td>${badgeEstado(r)}</td>
      <td>${r.programado ? "Programado" : "No programado"}</td>
      <td>${r.programado && r.horaProgramacion ? formatearFecha(r.horaProgramacion) : "—"}</td>
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

/* =========================================================
   ESTADÍSTICAS

   El render completo vive en shared/services/estadisticas.js:
   supervisor, cliente y admin muestran las mismas cifras y no
   pueden divergir. Aquí solo queda lo propio de este panel: qué
   periodo está viendo el usuario y qué registros entran.
   ========================================================= */

const MAX_DIAS_RANGO = 366;
let rangoRecortado = 0;

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
    rangoRecortado = 0;
    return Array.from(dias).sort();
  }

  const nDias = estadPeriodoActual === "3dias" ? 3 : estadPeriodoActual === "semana" ? 7 : estadPeriodoActual === "mes" ? 30 : 1;
  const dias = [];
  rangoRecortado = 0;
  for (let i = nDias - 1; i >= 0; i--) dias.push(sumarDias(hoyOp, -i));
  return dias;
}

/* El rango personalizado estaba topado en 60 días y recortaba en
   silencio: quien pedía tres meses veía dos y no se enteraba. El
   tope sigue existiendo (un año) porque cada día del rango es un
   punto en las gráficas, pero ahora cuando recorta lo dice. */
function buildDayRange(desde, hasta) {
  const dias = [];
  let cur = desde;
  while (cur <= hasta && dias.length < MAX_DIAS_RANGO) {
    dias.push(cur);
    cur = sumarDias(cur, 1);
  }

  const pedidos = Math.round(
    (new Date(hasta + "T12:00:00Z") - new Date(desde + "T12:00:00Z")) / 86400000
  ) + 1;
  rangoRecortado = Math.max(0, pedidos - dias.length);

  return dias.length ? dias : [todayOperativo(HORA_CORTE)];
}

function pintarAvisoRango() {
  const el = document.getElementById("estad-aviso-rango");
  if (!el) return;
  if (estadPeriodoActual !== "personalizado" || !rangoRecortado) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  el.textContent = "El rango pedido es más largo de lo que este panel puede graficar: se están " +
    "mostrando los primeros " + MAX_DIAS_RANGO + " días y quedaron " + rangoRecortado + " por fuera.";
}

function renderEstadisticas() {
  const base = registrosFiltrados();
  const dias = getDiasOperativosDelPeriodo();
  pintarAvisoRango();
  const diasSet = new Set(dias);

  renderPanelEstadisticas({
    recs: base.filter((r) => diasSet.has(getDiaOperativo(r, HORA_CORTE))),
    base: base,
    todos: registros,
    dias: dias,
    horaCorte: HORA_CORTE
  });
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
  XLSX.utils.book_append_sheet(libro, hoja, "Registros B9");
  XLSX.writeFile(libro, `registros_B9_${desde || "todo"}_a_${hasta || "hoy"}.xlsx`);
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