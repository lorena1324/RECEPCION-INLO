/* ============================================================
   clientes.js — Portería B9 · Rol Cliente (EMMA)
   Escrito desde cero como módulo ES, consumiendo directamente
   shared/core/guard.js y shared/services/{vehiculos,eventos}.js.
   Panel 100% de solo lectura, clonado del de supervisor para
   que el cliente vea el mismo nivel de detalle operativo.

   Diferencias con el panel de supervisor:
     - No edita nada: ni avance, ni autorizaciones de salida.
     - El Dashboard omite los datos de los operarios (quién
       atendió cada vehículo), porque al cliente le interesa el
       estado de su carga, no el desempeño del personal.
     - La vista de Registros SÍ trae todo, operarios incluidos:
       es el detalle completo de trazabilidad de cada vehículo.
   ============================================================ */

import { protegerPagina } from "../../../shared/core/guard.js";
import { cerrarSesionFirebase } from "../../../shared/core/auth.js";
import { cerrarSesionLocal } from "../../../shared/core/session.js";

import {
  suscribirseARegistros,
  getRegistrosEnPatio,
  getRegistrosEnMuelle,
  getMuellesOcupacion,
  requiereAvanceCompleto,
  estaCancelado
} from "../../../shared/services/vehiculos.js";

import {
  canalDe,
  getDestino,
  getDiaOperativo,
  getHistorial,
  getLocationDurations,
  minutosEsperando,
  minutosEnMuelle,
  nivelPrioridad,
  nivelContraMeta,
  faseActual,
  prioridadDe,
  enMuelleFueraDeMeta,
  ordenarPorPrioridad,
  diaConMasMovimiento,
  tituloHistorial
} from "../../../shared/services/eventos.js";

import { todayOperativo, sumarDias } from "../../../shared/utils/tiempos.js";

import {
  suscribirseAConfig,
  etiquetaCampo,
  tiemposDe,
  modalidadDe,
  distingueModalidad
} from "../../../shared/services/config.js";

import { fichaVehiculo } from "../../../shared/services/detalleVehiculo.js";

import {
  renderPanelEstadisticas,
  renderChartFranjaHoraria
} from "../../../shared/services/estadisticas.js";

const OPERACION = "B9";
const RUTA_LOGIN = "../../../index.html";

/* El número de muelles y el corte del turno los fija el
   administrador en config/{OPERACION}. Estos dos son el valor de
   partida: el que se usa mientras Firestore responde y el que se
   mantiene si la bodega todavía no los tiene configurados.

   El cliente lee la MISMA configuración que la portería a
   propósito: si su tablero mostrara otro número de muelles, o
   contara el día con otro corte, sus indicadores no cuadrarían con
   los de adentro y no habría forma de saber cuál de los dos miente.

   B9 (EMMA): el "día" del turno va de 6am a 6am, no de
   medianoche a medianoche. Ver shared/utils/tiempos.js. */
const MUELLES_POR_DEFECTO = 4;
const HORA_CORTE_POR_DEFECTO = 6;

let numMuelles = MUELLES_POR_DEFECTO;
let horaCorte = HORA_CORTE_POR_DEFECTO;

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
let unsubscribeConfig = null;
let perfilActual = null;

/* Configuración de la bodega (config/B9). De aquí salen las metas
   de tiempo en muelle por tipología: el cliente las lee para ver
   el MISMO semáforo que la portería. Empieza en null porque hasta
   que Firestore responda no hay meta contra la cual medir, y
   pintar un color sin ella sería inventarlo. */
let configBodega = null;

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

protegerPagina({ rolesPermitidos: ["cliente"], operacion: OPERACION }).then((perfil) => {

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

  // De la configuración este panel solo necesita el tamaño del
  // tablero y el corte del turno. Las reglas de Firestore le abren
  // el documento de su bodega; las tarifas viven en la subcolección
  // restringida y ni se piden.
  unsubscribeConfig = suscribirseAConfig(OPERACION, (config, error) => {
    if (error) {
      console.error("[clientes] No se pudo leer la configuración:", error);
      return;
    }
    configBodega = config;
    numMuelles = config.muelles || MUELLES_POR_DEFECTO;
    horaCorte = config.horaCorte != null ? config.horaCorte : HORA_CORTE_POR_DEFECTO;
    pintarTituloMuelles();
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
  if (unsubscribeConfig) unsubscribeConfig();
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

/* Hasta qué muelle llega el tablero. Lo pinta el JS y no viene fijo
   en el HTML porque el número sale de la configuración de la bodega
   y puede cambiar sin desplegar nada. */
function pintarTituloMuelles() {
  const el = document.getElementById("muelles-titulo");
  if (el) el.textContent = `Muelles (1 a ${numMuelles})`;
}

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
  const diaOp = todayOperativo(horaCorte);
  const entradasHoy = base.filter((r) => getDiaOperativo(r, horaCorte) === diaOp);
  const enAlerta = enPatio.filter((r) => nivelPrioridad(minutosEsperando(r)) === "alta");

  document.getElementById("kpi-patio").textContent = enPatio.length;
  document.getElementById("kpi-muelle").textContent = enMuelle.length;
  document.getElementById("kpi-hoy").textContent = entradasHoy.length;
  document.getElementById("kpi-alerta").textContent = enAlerta.length;

  const mejorDia = diaConMasMovimiento(base, horaCorte);
  if (mejorDia) {
    document.getElementById("kpi-mejor-dia-fecha").textContent = formatearFechaCorta(mejorDia.dia);
    document.getElementById("kpi-mejor-dia-detalle").textContent =
      `${mejorDia.total} movimientos (${mejorDia.entradas} entradas · ${mejorDia.salidas} salidas)`;
  } else {
    document.getElementById("kpi-mejor-dia-fecha").textContent = "—";
    document.getElementById("kpi-mejor-dia-detalle").textContent = "Sin datos todavía";
  }

  renderPrioridades(enPatio);

  // Alerta de muelle. Es OTRA alerta, no la misma con otro número:
  // el KPI "En alerta" cuenta la cola de patio contra el límite
  // general de la bodega, y esta avisa del vehículo que YA ESTÁ
  // operando y se pasó de la meta de SU tipología.
  pintarAlertaMuelle(enMuelle);

  const ultimos = ordenarPorPrioridad(base, configBodega).slice(0, 15);
  const tbody = document.getElementById("tabla-dashboard-body");
  tbody.innerHTML = ultimos.map(filaTabla).join("") || filaVacia(6);

  renderChartFranjaHoraria("chart-franja-horaria-dashboard", entradasHoy);
}

/* Los vehículos que ahora mismo llevan más de la meta de su
   tipología en muelle. Mismo criterio que ve la portería
   (enMuelleFueraDeMeta en eventos.js): si el tablero del cliente
   avisara con otra regla, las dos pantallas se contradirían. */
function pintarAlertaMuelle(enMuelle) {

  const banner = document.getElementById("alerta-muelle-banner");
  if (!banner) return;

  const fuera = enMuelleFueraDeMeta(enMuelle, configBodega);

  if (!fuera.length) {
    banner.style.display = "none";
    return;
  }

  banner.style.display = "flex";
  document.getElementById("alerta-muelle-detalle").textContent =
    `${fuera.length} vehículo(s) pasaron la meta de su tipología en muelle: ` +
    fuera.map((r) => {
      const p = prioridadDe(r, configBodega);
      return `${r.placa} (${formatearMinutos(p.minutos)} de ${formatearMinutos(p.meta)} · ${formatearMinutos(p.exceso)} por encima)`;
    }).join(", ");
}

/* Reparte los vehículos que están esperando en patio según su
   nivel de prioridad (los umbrales viven en eventos.js). */
function renderPrioridades(enPatio) {
  const conteo = { normal: 0, media: 0, alta: 0 };
  enPatio.forEach((r) => { conteo[nivelPrioridad(minutosEsperando(r))]++; });
  document.getElementById("prioridad-normal").textContent = conteo.normal;
  document.getElementById("prioridad-media").textContent = conteo.media;
  document.getElementById("prioridad-alta").textContent = conteo.alta;
}



/* El reloj de esta fila es el que gobierna al vehículo: el de
   muelle si está operando, el de patio si está esperando. Medirlos
   todos contra el de patio ponía a una mula 50 minutos pasada de
   su meta como "Normal". Ver prioridadDe() en eventos.js. */
function filaTabla(r) {
  const activo = !r.horaSalida;
  const p = prioridadDe(r, configBodega);

  return `
    <tr>
      <td><strong>${escapar(r.placa)}</strong></td>
      <td>${escapar(r.conductor || "—")}</td>
      <td>${formatearFecha(r.horaEntrada)}</td>
      <td>${escapar(getDestino(r))}</td>
      <td>${activo ? formatearMinutos(p.minutos) : "—"}</td>
      <td>${activo
        ? `<span class="badge badge-prioridad-${p.nivel}" title="${tituloPrioridad(p)}">${p.nivel === "alta" ? "Urgente" : p.nivel === "media" ? "Atención" : "Normal"}</span>`
        : `<span class="badge badge-online">Finalizado</span>`}
      </td>
    </tr>`;
}

/* Qué hay detrás del puesto en la fila: dónde está el vehículo,
   contra qué meta se le mide y cuánto lleva por encima. Sin esto
   el "#3" es un número que nadie puede verificar. */
function tituloPrioridad(p) {
  if (!p.referencia) return `${p.ubicacion} · sin meta configurada`;
  return `${p.ubicacion} · ${formatearMinutos(p.minutos)} de ${formatearMinutos(p.referencia)}` +
    (p.estimada ? " (promedio de la bodega — a este vehículo le falta la tipología)" : "") +
    (p.exceso ? ` · ${formatearMinutos(p.exceso)} por encima` : "");
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
  const ocupacion = getMuellesOcupacion(enMuelle, numMuelles);

  const grid = document.getElementById("grid-muelles");
  let html = "";

  for (let n = 1; n <= numMuelles; n++) {
    const r = ocupacion[n];

    // La alerta del muelle sale de la meta de la tipología del
    // vehículo, no de un umbral igual para todos.
    const nivel = r ? nivelMuelle(r) : "normal";

    html += `
      <div class="muelle-card ${r ? "ocupado" : "libre"} ${nivel !== "normal" ? "muelle-" + nivel : ""}">
        <div class="muelle-card-top">
          <span class="muelle-card-num">Muelle ${n}</span>
          <span class="muelle-card-status ${r ? "ocupado" : "libre"}">${r ? "OCUPADO" : "LIBRE"}</span>
        </div>
        ${r ? avisoMetaMuelle(r) : ""}
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

  const enPatio = ordenarPorPrioridad(getRegistrosEnPatio(base), configBodega);
  document.getElementById("tabla-patio-body").innerHTML = enPatio.map(filaPatio).join("") || filaVacia(8);
}

function claseTipo(tipo) {
  return tipo === "Cargue" ? "badge-cargue" : tipo === "Descargue" ? "badge-descargue" : "badge-ambos";
}


/* =========================================================
   LA ALERTA DEL MUELLE

   El reloj del muelle no es el del patio. Esperar en la fila es
   igual para todos —un límite por bodega— pero operar no: la meta
   de tiempo en muelle sale de la tipología del vehículo y de la
   fase en la que va, y la fija el administrador en Configuración.

   El cliente ve el MISMO semáforo que la portería a propósito: si
   su tablero marcara en rojo con otro criterio, las dos pantallas
   se contradirían y no habría forma de saber cuál miente.
   ========================================================= */

function nivelMuelle(r) {
  return nivelContraMeta(
    minutosEnMuelle(r),
    tiemposDe(configBodega, r.tipologia, faseActual(r), modalidadDe(r))
  );
}

/* Cuánto lleva en muelle y contra qué meta. El cliente ve el
   avance de SU carga, así que ve la cifra completa — no es un dato
   de desempeño del personal, es el estado del vehículo. */
function avisoMetaMuelle(r) {

  const meta = tiemposDe(configBodega, r.tipologia, faseActual(r), modalidadDe(r));
  const min = minutosEnMuelle(r);

  if (!meta) {
    return '<div class="muelle-meta sin-meta"><i class="ti ti-help-circle"></i> ' +
           formatearMinutos(min) + " en muelle</div>";
  }

  const nivel = nivelContraMeta(min, meta);
  const icono = nivel === "alta" ? "ti-alert-triangle" : nivel === "media" ? "ti-clock-exclamation" : "ti-clock-check";

  return `<div class="muelle-meta ${nivel}"><i class="ti ${icono}"></i> ` +
         `${formatearMinutos(min)} de ${formatearMinutos(meta.meta)}` +
         (distingueModalidad(configBodega) ? ` · ${escapar(modalidadDe(r).toLowerCase())}` : "") +
         (nivel !== "normal" ? ` · ${formatearMinutos(min - meta.meta)} por encima` : "") +
         "</div>";
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
      <td><button class="btn btn-sm" data-novedades="${r.id}"><i class="ti ti-info-circle"></i></button></td>
    </tr>`;
}

/* =========================================================
   AVANCE DE CARGUE/DESCARGUE (dentro de la tarjeta de muelle)

   Aquí es solo lectura: se muestra la barra con el porcentaje
   que va marcando el supervisor, y la constancia de si hubo
   autorización de salida anticipada. El cliente no lo edita.
   ========================================================= */

function getAvanceTipoEfectivo(r) {
  if (r.avanceTipo) return r.avanceTipo;
  if (r.tipo === "Cargue" || r.tipo === "Descargue") return r.tipo;
  return null;
}

function renderAvance(r) {
  const avanceTipo = getAvanceTipoEfectivo(r);

  if (!requiereAvanceCompleto(r) || !avanceTipo) {
    return `<div class="avance-box"><span class="avance-label">Avance sin registrar</span></div>`;
  }

  const pct = r.avancePorcentaje || 0;
  const claseBadge = avanceTipo === "Cargue" ? "badge-cargue" : "badge-descargue";

  let aviso = "";
  if (r.autorizacionSalida && r.autorizacionSalida.motivo && pct < 100) {
    aviso = `<div style="margin-top:4px;font-size:11px;color:#3B6D11;"><i class="ti ti-shield-check"></i> Salida anticipada autorizada</div>`;
  }

  return `
    <div class="avance-box">
      <div class="avance-info">
        <span class="badge ${claseBadge}">${avanceTipo}</span>
        <span class="avance-pct">${pct}%</span>
      </div>
      <div class="avance-bar"><div class="avance-bar-fill" style="width:${pct}%"></div></div>
      ${aviso}
    </div>`;
}

function iniciarAvanceClicks() {
  document.body.addEventListener("click", (e) => {
    const btnNovedades = e.target.closest("[data-novedades]");
    if (btnNovedades) {
      openModalNovedades(btnNovedades.getAttribute("data-novedades"));
      return;
    }
    const btnClose = e.target.closest("[data-close]");
    if (btnClose) closeModal(btnClose.getAttribute("data-close"));
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

  /* La ficha compartida, la misma que ve el cliente de J4. Este
     modal armaba a mano cinco filas, así que se quedaba sin
     tipología, sin tiempos por ubicación, sin el avance y sin cómo
     vino la mercancía — el dato del que cuelga la meta de tiempo en
     muelle contra la que se está midiendo su carga.

     Ver el encabezado de detalleVehiculo.js: la ficha vive en un
     solo sitio para que los tres roles lean lo mismo. El cliente no
     recibe `cobro`, así que el bloque de dinero no se pinta. */
  document.getElementById("modal-novedades-body").innerHTML =
    fichaVehiculo(rec, {
      etiquetas: {
        conductor: etiquetaCampo(configBodega, "conductor"),
        cedula: etiquetaCampo(configBodega, "cedula")
      },
      distingueModalidad: distingueModalidad(configBodega),
      mostrarOperarios: true
    }) +
    seccionAutorizacion(rec) +
    `<div class="detail-section-title">Novedades</div>${histHtml}`;

  document.getElementById("modal-novedades").classList.add("open");
}

/* =========================================================
   AUTORIZACIÓN DE SALIDA ANTICIPADA (solo Cargue)

   Reglas de negocio: en Descargue no hay excepción posible (debe
   llegar al 100%). En Cargue, por debajo del mínimo tampoco hay
   excepción — recién entre ese mínimo y el 99% el supervisor puede
   autorizar la salida explicando el motivo, que queda grabado
   en el historial del vehículo.
   ========================================================= */

function seccionAutorizacion(r) {
  if (!r.autorizacionSalida || !r.autorizacionSalida.motivo) return "";
  const a = r.autorizacionSalida;
  return `<div class="detail-section-title">Autorización de salida anticipada</div>
    <p style="font-size:12.5px;">Autorizada el ${formatearFecha(a.fecha)} con ${a.porcentajeAlAutorizar || 0}% de avance.<br>Motivo: ${escapar(a.motivo)}</p>`;
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

  filtrados = ordenarPorPrioridad(filtrados, configBodega);

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

/* El puesto en la fila ya no se decide con el mismo reloj para
   todos: el que está en muelle corre contra la meta de SU
   tipología y el que espera afuera contra el límite de patio. El
   badge muestra el reloj que efectivamente lo está midiendo. Ver
   prioridadDe() en eventos.js. */
function prioridadRegistro(r, rank) {
  if (r.horaSalida) return '<span class="badge badge-salio">—</span>';
  const p = prioridadDe(r, configBodega);
  const clase = p.nivel === "alta" ? "badge-amber" : p.nivel === "media" ? "badge-descargue" : "badge-en-patio";
  return `<span class="badge ${clase}" title="${tituloPrioridad(p)}"><i class="ti ti-flag-3"></i> #${rank} · ${formatearMinutos(p.minutos)}</span>`;
}

function badgeEstado(r) {
  // Va antes que "Salió" porque un cancelado también trae hora de
  // salida. El cliente tiene que poder distinguir el vehículo que se
  // atendió del que no se atendió: es su carga la que no se movió.
  if (estaCancelado(r)) {
    const llego = r.cancelacion && r.cancelacion.llego;
    return `<span class="badge badge-cancelado" title="${escapar((r.cancelacion && r.cancelacion.motivo) || "")}">
              <i class="ti ti-ban"></i> ${llego ? "Cancelado" : "No llegó"}
            </span>`;
  }
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
      const hoyOp = todayOperativo(horaCorte);
      document.getElementById("estad-hasta").value = hoyOp;
      document.getElementById("estad-desde").value = hoyOp;
    }
    return; // esperar a que el usuario pulse "Aplicar"
  }

  custom.style.display = "none";
  renderEstadisticas();
}

function getDiasOperativosDelPeriodo() {
  const hoyOp = todayOperativo(horaCorte);

  if (estadPeriodoActual === "personalizado") {
    const desde = document.getElementById("estad-desde").value;
    const hasta = document.getElementById("estad-hasta").value;
    return buildDayRange(desde || hoyOp, hasta || hoyOp);
  }

  if (estadPeriodoActual === "todo") {
    const base = registrosFiltrados();
    const dias = new Set();
    base.forEach((r) => {
      const d = getDiaOperativo(r, horaCorte);
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

  return dias.length ? dias : [todayOperativo(horaCorte)];
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
    recs: base.filter((r) => diasSet.has(getDiaOperativo(r, horaCorte))),
    base: base,
    todos: registros,
    dias: dias,
    horaCorte: horaCorte
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
