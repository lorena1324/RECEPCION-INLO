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
  minimoDe,
  requiereAvanceCompleto,
  avanceCompleto,
  cancelarVehiculo,
  crearCitaCancelada,
  actualizarModalidad,
  actualizarTipologia,
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

import {
  suscribirseAConfig,
  obtenerTarifas,
  tarifasPorDefecto,
  desglosarTarifa,
  tiemposDe,
  buscarTipologia,
  modalidadDe,
  distingueModalidad,
  MODALIDADES,
  etiquetaCampo
} from "../../../shared/services/config.js";

import {
  MEDIOS_PAGO,
  SOPORTES_PAGO,
  SOPORTE_POR_DEFECTO,
  soporteEntraACaja,
  soporteDe,
  tarifaDeSoporte,
  repartir,
  validarCobro,
  registrarCobro,
  suscribirseACobros,
  pendientesDeCobro,
  sinTipologia,
  resumenCaja
} from "../../../shared/services/cobros.js";

import { fichaVehiculo } from "../../../shared/services/detalleVehiculo.js";

import { todayOperativo, sumarDias, formatDuration } from "../../../shared/utils/tiempos.js";

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
let perfilActual = null;

/* Cobros y configuración de la bodega. Los cobros llegan como un
   mapa { vehiculoId: cobro } porque para cada fila de la tabla hay
   que saber si ese vehículo ya se cobró, y recorrer un array por
   fila sería cuadrático. */
let configBodega = null;
let cobros = {};
let unsubscribeConfig = null;
let unsubscribeCobros = null;

/* Las tarifas NO vienen con el resto de la configuración: viven en
   una subcolección restringida que el operario no puede leer (ver
   el encabezado de config.js). El supervisor sí, así que se piden
   aparte y se refrescan cada vez que la configuración cambia —el
   administrador guarda las dos mitades juntas. */
let tarifas = tarifasPorDefecto();

/* Vehículo cuyo cobro se está registrando en el modal, con el medio
   de pago y el soporte elegidos. Se guardan aquí y no se leen del
   DOM para que una actualización en vivo del panel no pueda
   cambiarlos a mitad del registro. */
let cobroVehiculo = null;
let cobroMedio = null;
let cobroSoporte = SOPORTE_POR_DEFECTO;

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
  iniciarCobros();
  iniciarCancelaciones();

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
    refrescarModalDetalle();
  });

  // La configuración dice si esta bodega cobra y trae las tipologías.
  // Las tarifas llegan aparte (subcolección restringida) y se
  // refrescan aquí: el administrador guarda ambas mitades juntas, así
  // que un cambio en la configuración es la señal de releerlas.
  unsubscribeConfig = suscribirseAConfig(OPERACION, (config, error) => {
    if (error) {
      console.error("[supervisor] No se pudo leer la configuración:", error);
      return;
    }
    configBodega = config;

    // El tablero de muelles y el corte del turno salen de aquí: un
    // cambio del administrador se ve sin recargar la página.
    numMuelles = config.muelles || MUELLES_POR_DEFECTO;
    horaCorte = config.horaCorte != null ? config.horaCorte : HORA_CORTE_POR_DEFECTO;

    pintarTituloMuelles();
    pintarEtiquetasCampos();
    pintarBotonCitaCancelada();
    renderTodo();

    obtenerTarifas(OPERACION)
      .then((res) => {
        tarifas = res.tarifas;
        renderCobros();
      })
      .catch((e) => console.error("[supervisor] No se pudieron leer las tarifas:", e));

    renderCobros();
  });

  unsubscribeCobros = suscribirseACobros(OPERACION, (data, error) => {
    if (error) {
      console.error("[supervisor] No se pudieron leer los cobros:", error);
      return;
    }
    cobros = data || {};
    renderCobros();
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
  if (unsubscribeCobros) unsubscribeCobros();
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
    cobros: "Cobros",
    exportar: "Exportar"
  };
  document.getElementById("titulo-vista").textContent = titulos[nombre] || nombre;

  if (nombre === "estadisticas") renderEstadisticas();
  if (nombre === "cobros") renderCobros();
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

/* Los dos campos libres se llaman como los llame esta bodega: en
   J3 y B9, conductor y cédula; en J4, proveedor y número de cita.
   Aquí solo se rotulan las cabeceras y el buscador — el supervisor
   no captura estos datos, solo los lee. */
function pintarEtiquetasCampos() {

  const conductor = etiquetaCampo(configBodega, "conductor");

  document.querySelectorAll(".th-conductor").forEach((th) => {
    th.textContent = conductor;
  });

  const buscador = document.getElementById("f-placa");
  if (buscador) buscador.placeholder = `Buscar por placa o ${conductor.toLowerCase()}…`;
}

function renderTodo() {
  renderDashboard();
  renderUbicacion();
  renderRegistros();
  // renderCobros() se llama siempre, no solo con la vista abierta:
  // el contador de pendientes del menú tiene que estar al día
  // aunque el supervisor esté mirando el dashboard.
  renderCobros();
  if (document.getElementById("view-estadisticas").classList.contains("active")) {
    renderEstadisticas();
  }
}

/* =========================================================
   COBROS

   Solo se usa donde la configuración dice que la bodega cobra.
   La tarifa NO se digita: la fija la tipología del vehículo desde
   el panel del administrador. Lo único que se captura aquí es por
   qué medio se pagó y, cuando fue mixto, cuánto entró en efectivo
   — el QR sale del resto, para que la suma no pueda descuadrarse.
   ========================================================= */

function bodegaCobra() {
  return !!(configBodega && configBodega.cobraVehiculos);
}

/*
    El desglose de la tarifa que le corresponde a un vehículo por su
    tipología: base, IVA, valor con IVA, tasa de INLOTRANS y lo que
    le queda a la cuadrilla. Cuál de esas cifras se cobra lo decide
    el soporte de pago, no esta función.
*/
function desgloseDe(rec) {
  if (!rec || !rec.tipologia) return desglosarTarifa(tarifas, null);
  return desglosarTarifa(tarifas, rec.tipologia);
}

/* Pesos colombianos, sin decimales: las tarifas de portería no los
   usan y los centavos solo ensucian la lectura de la caja. */
function fmtMoneda(valor) {
  return "$" + Math.round(Number(valor) || 0).toLocaleString("es-CO");
}

function minutosAdentro(rec) {
  if (!rec || !rec.horaEntrada) return 0;
  const fin = rec.horaSalida ? new Date(rec.horaSalida) : new Date();
  return Math.max(0, (fin - new Date(rec.horaEntrada)) / 60000);
}

/* El ítem del menú y su contador. Se ocultan enteros donde no se
   cobra: un menú con una sección que nunca aplica invita a entrar
   a buscar algo que no está. */
function renderNavCobros() {

  const nav = document.getElementById("nav-cobros");
  const badge = document.getElementById("nav-cobros-badge");
  if (!nav) return;

  if (!bodegaCobra()) {
    nav.style.display = "none";
    return;
  }

  nav.style.display = "";

  const n = pendientesDeCobro(registros, cobros).length;
  badge.textContent = n;
  badge.style.display = n ? "" : "none";
}

function renderCobros() {

  if (!document.getElementById("view-cobros")) return;

  renderNavCobros();
  if (!bodegaCobra()) return;

  renderResumenCaja();
  renderPendientesCobro();
  renderCobrosRegistrados();
}

/* La caja del día operativo en curso, no de toda la historia: lo
   que el supervisor cuadra al cerrar el turno. */
function renderResumenCaja() {

  const diaOp = todayOperativo(horaCorte);

  const deHoy = Object.keys(cobros)
    .map((k) => cobros[k])
    .filter((c) => diaOperativoDeCobro(c) === diaOp);

  const r = resumenCaja(deHoy);

  document.getElementById("caja-total").textContent = fmtMoneda(r.total);
  document.getElementById("caja-efectivo").textContent = fmtMoneda(r.totalEfectivo);
  document.getElementById("caja-qr").textContent = fmtMoneda(r.totalQR);
  document.getElementById("caja-vehiculos").textContent = r.vehiculos;

  // El IVA que se liquidó de verdad: solo lo cobrado con factura.
  // Lo del recibo de caja menor se cobró sin impuesto y no se puede
  // sumar aquí, o la declaración saldría inflada.
  document.getElementById("caja-iva").textContent = fmtMoneda(r.totalIva);
  document.getElementById("caja-cuadrilla").textContent = fmtMoneda(r.totalCuadrilla);
  document.getElementById("caja-inlo").textContent = fmtMoneda(r.gananciaInlo);

  // El desglose por medio se dice siempre, incluso en ceros: es la
  // cifra que se compara contra el datáfono y el reporte del QR.
  document.getElementById("caja-desglose").innerHTML =
    r.porMedio.Efectivo.n + " solo efectivo · " +
    r.porMedio.QR.n + " solo QR · " +
    r.porMedio.Ambos.n + " mixtos" +
    (r.facturados
      ? "<br>" + r.facturados + " facturado(s) por " + fmtMoneda(r.totalFacturado) +
        " — no entra a la caja"
      : "");

  // Y por soporte, que es contra lo que se cuadra el talonario de
  // la caja menor al cerrar el turno.
  document.getElementById("caja-soportes").innerHTML =
    r.porSoporte["Recibo Caja Menor"].n + " con recibo de caja menor (" +
    fmtMoneda(r.porSoporte["Recibo Caja Menor"].monto) + ") · " +
    r.porSoporte["Factura"].n + " con factura (" +
    fmtMoneda(r.porSoporte["Factura"].monto) + ")";
}

function diaOperativoDeCobro(c) {
  if (!c || !c.fecha) return null;
  const d = new Date(c.fecha);
  if (isNaN(d)) return null;
  d.setHours(d.getHours() - horaCorte);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}

function renderPendientesCobro() {

  const pendientes = pendientesDeCobro(registros, cobros);
  const tbody = document.getElementById("tabla-pendientes-body");

  tbody.innerHTML = pendientes.length
    ? pendientes.map((r) => {
        // Se muestra el valor sin IVA porque es el que se cobra en el
        // caso corriente (recibo de caja menor). El otro va al lado,
        // para que quien pide factura no tenga que abrir el modal
        // para saber cuánto le va a tocar cobrar.
        const d = desgloseDe(r);
        return `<tr>
          <td><strong>${escapar(r.placa)}</strong></td>
          <td>${escapar(r.conductor || "—")}</td>
          <td>${escapar(r.tipologiaNombre || "—")}</td>
          <td class="monto${d.base ? "" : " cero"}">${d.base
            ? fmtMoneda(d.base) + '<span class="monto-alterno">' + fmtMoneda(d.conIva) + " con factura</span>"
            : "sin tarifa"}</td>
          <td>${formatearFechaCorta(r.horaEntrada)}</td>
          <td>${formatDuration(minutosAdentro(r))}</td>
          <td><button class="btn-primario" data-cobrar="${escapar(r.id)}"><i class="ti ti-cash"></i> Cobrar</button></td>
        </tr>`;
      }).join("")
    : filaVacia(7);

  // Los vehículos sin tipología no salen arriba porque no se les
  // puede cobrar todavía. Sin decirlo, una lista corta se leería
  // como "no falta nada", cuando lo que falta es otra cosa.
  const sinTipo = sinTipologia(registros);
  const aviso = document.getElementById("cobros-aviso-sin-tipologia");

  aviso.innerHTML = sinTipo.length
    ? '<div class="cobros-aviso"><i class="ti ti-alert-triangle"></i> Hay <strong>' + sinTipo.length +
      " vehículo(s) adentro sin tipología asignada</strong> (" +
      sinTipo.slice(0, 5).map((r) => escapar(r.placa)).join(", ") +
      (sinTipo.length > 5 ? "…" : "") +
      "). No aparecen arriba porque sin tipología no hay tarifa que cobrar, y tampoco podrán salir. " +
      "Hay que asignársela desde portería.</div>"
    : "";
}

function renderCobrosRegistrados() {

  const diaOp = todayOperativo(horaCorte);

  const deHoy = Object.keys(cobros)
    .map((k) => cobros[k])
    .filter((c) => diaOperativoDeCobro(c) === diaOp)
    .sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));

  const tbody = document.getElementById("tabla-cobros-body");

  tbody.innerHTML = deHoy.length
    ? deHoy.map((c) => {
        // Corregir solo mientras el vehículo no haya salido: después
        // la caja del turno ya se cuadró contra estas cifras.
        const rec = registros.find((r) => r.id === c.vehiculoId);
        const editable = rec && !rec.horaSalida;

        // El total de la fila es lo que entró a la caja. En un cobro
        // facturado al cliente los dos montos van en cero y el valor
        // se muestra desde `tarifa`, marcado, para que no se lea como
        // si el vehículo no hubiera pagado nada.
        const soporte = soporteDe(c);
        const entro = soporteEntraACaja(soporte);
        const total = entro ? (c.montoEfectivo || 0) + (c.montoQR || 0) : (c.tarifa || 0);

        return `<tr>
          <td><strong>${escapar(c.placa)}</strong></td>
          <td>${escapar(c.tipologiaNombre || "—")}</td>
          <td><span class="badge-soporte">${escapar(soporte)}</span></td>
          <td><span class="badge-medio ${c.medio.toLowerCase()}">${escapar(c.medio)}</span></td>
          <td class="monto${c.montoEfectivo ? "" : " cero"}">${fmtMoneda(c.montoEfectivo)}</td>
          <td class="monto${c.montoQR ? "" : " cero"}">${fmtMoneda(c.montoQR)}</td>
          <td class="monto${entro ? "" : " cero"}"><strong>${fmtMoneda(total)}</strong>${entro ? "" : " <em>(facturado)</em>"}</td>
          <td>${escapar(c.registradoPor || "—")}${c.editadoPor ? " <em>(corregido)</em>" : ""}</td>
          <td>${editable
            ? `<button class="btn-link" data-cobrar="${escapar(c.vehiculoId)}"><i class="ti ti-edit"></i> Corregir</button>`
            : ""}</td>
        </tr>`;
      }).join("")
    : filaVacia(9);
}


/* ── Modal de cobro ── */

function abrirModalCobro(vehiculoId) {

  const rec = registros.find((r) => r.id === vehiculoId);
  if (!rec) return;

  const existente = cobros[vehiculoId] || null;

  cobroVehiculo = rec;
  cobroMedio = existente ? existente.medio : null;

  // Al corregir se retoma el soporte que se registró; en un cobro
  // nuevo se arranca en el recibo de caja menor, que es el caso
  // corriente. La factura es la excepción y hay que elegirla.
  cobroSoporte = existente ? soporteDe(existente) : SOPORTE_POR_DEFECTO;
  if (!soporteEntraACaja(cobroSoporte)) cobroMedio = null;

  document.getElementById("cobro-info").innerHTML =
    "<strong>" + escapar(rec.placa) + "</strong> — " + escapar(rec.conductor || "sin conductor") +
    " · " + escapar(rec.tipologiaNombre || "sin tipología") +
    (existente ? " <em>(corrigiendo un cobro ya registrado)</em>" : "");

  document.getElementById("cobro-efectivo").value = existente && existente.medio === "Ambos"
    ? existente.montoEfectivo
    : "";

  pintarSoportes();
  pintarMediosPago();
  document.getElementById("cobro-errores").style.display = "none";

  document.getElementById("modal-cobro").classList.add("open");
}

function pintarMediosPago() {
  document.querySelectorAll("#cobro-medios .medio-btn").forEach((btn) => {
    btn.classList.toggle("activo", btn.dataset.medio === cobroMedio);
  });
}

/*
    El soporte elegido, cuánto se cobra por haberlo elegido y el
    desglose de esa cifra. Se muestra siempre —no solo cuando hay
    factura de por medio— porque la diferencia entre cobrar
    $38.000 y $45.220 es justamente lo que decide este botón, y
    equivocarse aquí es equivocarse en la caja.
*/
function pintarSoportes() {

  document.querySelectorAll("#cobro-soportes .soporte-btn").forEach((btn) => {
    btn.classList.toggle("activo", btn.dataset.soporte === cobroSoporte);
  });

  const d = desgloseDe(cobroVehiculo);
  const total = tarifaDeSoporte(d, cobroSoporte);
  const conIva = cobroSoporte !== SOPORTE_POR_DEFECTO;

  document.getElementById("cobro-tarifa").textContent = fmtMoneda(total);
  document.getElementById("cobro-tarifa-label").textContent = conIva
    ? "Se cobra el valor con IVA"
    : "Se cobra el valor antes de IVA";

  document.getElementById("cobro-tarifa-detalle").innerHTML = d.base
    ? "Base " + fmtMoneda(d.base) +
      " · IVA (" + d.ivaPorcentaje + "%) " + fmtMoneda(d.iva) +
      (conIva ? "" : " — no se liquida con recibo de caja menor") +
      "<br>Cuadrilla " + fmtMoneda(d.cuadrilla) + " · INLO " + fmtMoneda(d.tasaInlo)
    : "Esta tipología no tiene tarifa configurada.";

  // Facturado al cliente: no hay plata en portería, así que el
  // bloque de medios se oculta. Dejarlo visible pero inerte solo
  // invitaría a llenarlo para nada.
  const entraACaja = soporteEntraACaja(cobroSoporte);
  document.getElementById("cobro-medio-wrap").style.display = entraACaja ? "" : "none";

  if (!entraACaja) {
    document.getElementById("cobro-split").style.display = "none";
    return;
  }

  pintarSplitCobro();
}

/* El campo de reparto solo aparece con "Ambos": en los otros dos
   medios el monto es la tarifa completa y no hay nada que decidir. */
function pintarSplitCobro() {

  const split = document.getElementById("cobro-split");
  split.style.display = cobroMedio === "Ambos" ? "" : "none";

  if (cobroMedio !== "Ambos") return;

  // El total a repartir depende del soporte: con factura hay que
  // repartir el valor con IVA, no la base.
  const total = tarifaDeSoporte(desgloseDe(cobroVehiculo), cobroSoporte);
  const efectivo = Number(document.getElementById("cobro-efectivo").value) || 0;
  const montos = repartir("Ambos", total, efectivo);

  document.getElementById("cobro-qr-calculado").textContent = fmtMoneda(montos.montoQR);
}

function seleccionarMedio(medio) {
  if (MEDIOS_PAGO.indexOf(medio) === -1) return;
  cobroMedio = medio;
  pintarMediosPago();
  pintarSplitCobro();
}

function seleccionarSoporte(soporte) {
  if (SOPORTES_PAGO.indexOf(soporte) === -1) return;
  cobroSoporte = soporte;
  if (!soporteEntraACaja(soporte)) cobroMedio = null;
  pintarSoportes();
  pintarMediosPago();
}

function pintarErroresCobro(errores) {
  const el = document.getElementById("cobro-errores");
  if (!errores.length) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  el.innerHTML = errores.map((e) => escapar(e)).join("<br>");
}

async function confirmarCobro() {

  if (!cobroVehiculo) return;

  const desglose = desgloseDe(cobroVehiculo);
  const datos = {
    soporte: cobroSoporte,
    medio: cobroMedio,
    montoEfectivo: Number(document.getElementById("cobro-efectivo").value) || 0,
    desglose: desglose,
    esCorreccion: !!cobros[cobroVehiculo.id]
  };

  const errores = validarCobro(datos, desglose);
  pintarErroresCobro(errores);
  if (errores.length) return;

  const btn = document.getElementById("btn-confirmar-cobro");
  btn.disabled = true;

  try {
    await registrarCobro(OPERACION, cobroVehiculo, datos, perfilActual.nombre);
    closeModal("modal-cobro");
    cobroVehiculo = null;
    cobroMedio = null;
    cobroSoporte = SOPORTE_POR_DEFECTO;
  } catch (error) {
    console.error("Error al registrar el cobro:", error);
    pintarErroresCobro(["No se pudo guardar el cobro. Revisa la conexión e inténtalo de nuevo."]);
  } finally {
    btn.disabled = false;
  }
}

function iniciarCobros() {

  document.querySelectorAll("#cobro-medios .medio-btn").forEach((btn) => {
    btn.addEventListener("click", () => seleccionarMedio(btn.dataset.medio));
  });

  document.querySelectorAll("#cobro-soportes .soporte-btn").forEach((btn) => {
    btn.addEventListener("click", () => seleccionarSoporte(btn.dataset.soporte));
  });

  document.getElementById("cobro-efectivo").addEventListener("input", pintarSplitCobro);
  document.getElementById("btn-confirmar-cobro").addEventListener("click", confirmarCobro);

  // Los botones de las tablas se generan en cada repintado, así que
  // van por delegación en vez de re-enlazarse uno por uno.
  document.getElementById("view-cobros").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cobrar]");
    if (btn) abrirModalCobro(btn.getAttribute("data-cobrar"));
  });
}


/* =========================================================
   VEHÍCULOS CANCELADOS

   Dos caminos al mismo estado, según el vehículo haya llegado o
   no. Los dos exigen motivo: una cifra de cancelados sin razones
   detrás no le sirve a nadie para corregir nada.

   Es una decisión del supervisor y no de portería a propósito —
   ver el comentario de camposSoloDeSupervisor en firestore.rules:
   quien está en la puerta no debería tener a mano la forma de
   hacer desaparecer un vehículo que se demoró.
   ========================================================= */

let cancelarVehiculoId = null;

function abrirModalCancelar(id) {

  const rec = registros.find((r) => r.id === id);
  if (!rec) return;

  cancelarVehiculoId = id;

  document.getElementById("cancelar-info").innerHTML =
    `<strong>${escapar(rec.placa)}</strong> — ${escapar(rec.conductor || "sin registrar")}` +
    ` · ${escapar(getDestino(rec))}`;

  document.getElementById("cancelar-motivo").value = "";
  document.getElementById("cancelar-errores").style.display = "none";

  document.getElementById("modal-cancelar").classList.add("open");
  document.getElementById("cancelar-motivo").focus();
}

async function confirmarCancelacion() {

  const rec = registros.find((r) => r.id === cancelarVehiculoId);
  if (!rec) return;

  const motivo = document.getElementById("cancelar-motivo").value.trim();
  const errores = document.getElementById("cancelar-errores");

  if (!motivo) {
    errores.style.display = "";
    errores.textContent = "Escribe por qué se cancela. Queda en el historial del vehículo.";
    return;
  }

  const btn = document.getElementById("btn-confirmar-cancelar");
  btn.disabled = true;

  try {
    await cancelarVehiculo(rec.id, { motivo: motivo }, perfilActual.nombre);
    closeModal("modal-cancelar");
    cancelarVehiculoId = null;
  } catch (error) {
    console.error("[supervisor] No se pudo cancelar:", error);
    errores.style.display = "";
    errores.textContent = "No se pudo guardar la cancelación. Revisa la conexión e inténtalo de nuevo.";
  } finally {
    btn.disabled = false;
  }
}

/* ── Cita cancelada de un vehículo que nunca llegó ── */

function abrirModalCitaCancelada() {

  document.getElementById("cita-placa").value = "";
  document.getElementById("cita-conductor").value = "";
  document.getElementById("cita-cedula").value = "";
  document.getElementById("cita-fecha").value = todayOperativo(horaCorte);
  document.getElementById("cita-hora").value = "";
  document.getElementById("cita-motivo").value = "";
  document.getElementById("cita-errores").style.display = "none";

  // Los dos campos libres se rotulan como los llame esta bodega:
  // aquí se está anotando el proveedor y el número de la cita, no
  // un conductor con su cédula.
  document.getElementById("lbl-cita-conductor").textContent = etiquetaCampo(configBodega, "conductor");
  document.getElementById("lbl-cita-cedula").textContent = etiquetaCampo(configBodega, "cedula");

  document.getElementById("modal-cita-cancelada").classList.add("open");
  document.getElementById("cita-placa").focus();
}

async function confirmarCitaCancelada() {

  const errores = document.getElementById("cita-errores");
  const placa = document.getElementById("cita-placa").value.trim().toUpperCase();
  const motivo = document.getElementById("cita-motivo").value.trim();
  const fecha = document.getElementById("cita-fecha").value;
  const hora = document.getElementById("cita-hora").value;

  const fallos = [];
  if (!placa) fallos.push("Falta la placa del vehículo que no llegó.");
  if (!fecha) fallos.push("Falta la fecha de la cita.");
  if (!motivo) fallos.push("Escribe por qué se canceló la cita.");

  if (fallos.length) {
    errores.style.display = "";
    errores.innerHTML = fallos.map((f) => escapar(f)).join("<br>");
    return;
  }

  // La cancelación pertenece al día de la cita, no al día en que
  // alguien se acuerda de registrarla. Sin hora se ancla al mediodía
  // para que el corte del turno la deje en el día correcto.
  const horaProgramacion = fecha + "T" + (hora || "12:00");

  const btn = document.getElementById("btn-confirmar-cita");
  btn.disabled = true;

  try {
    await crearCitaCancelada(OPERACION, {
      placa: placa,
      conductor: document.getElementById("cita-conductor").value.trim(),
      cedula: document.getElementById("cita-cedula").value.trim(),
      horaProgramacion: horaProgramacion,
      motivo: motivo
    }, perfilActual.nombre);

    closeModal("modal-cita-cancelada");
  } catch (error) {
    console.error("[supervisor] No se pudo registrar la cita cancelada:", error);
    errores.style.display = "";
    errores.textContent = "No se pudo guardar. Revisa la conexión e inténtalo de nuevo.";
  } finally {
    btn.disabled = false;
  }
}

function iniciarCancelaciones() {

  document.getElementById("btn-confirmar-cancelar").addEventListener("click", confirmarCancelacion);
  document.getElementById("btn-confirmar-cita").addEventListener("click", confirmarCitaCancelada);
  document.getElementById("btn-cita-cancelada").addEventListener("click", abrirModalCitaCancelada);

  // Los botones de las filas se generan en cada repintado, así que
  // van por delegación en vez de re-enlazarse uno por uno.
  document.body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cancelar]");
    if (btn) abrirModalCancelar(btn.getAttribute("data-cancelar"));
  });
}

/* El botón de registrar una cita cancelada solo existe donde la
   bodega maneja cancelaciones. */
function pintarBotonCitaCancelada() {
  const btn = document.getElementById("btn-cita-cancelada");
  if (btn) btn.style.display = manejaCancelaciones() ? "" : "none";
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
   tipología en muelle. La lista y el criterio viven en
   enMuelleFueraDeMeta() (eventos.js), para que la portería y el
   supervisor no puedan avisar de cosas distintas. */
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
   UBICACIÓN EN VIVO — tablero de 3 muelles + patio

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

   Pasarse de esa meta enciende el amarillo; doblarla, el rojo. Es
   la misma escala que usa el patio (ver nivelContraMeta), solo que
   contra otra meta.
   ========================================================= */

/* =========================================================
   CLASIFICAR EL VEHÍCULO (tipología y modalidad)

   Los dos datos que el vehículo necesita para poder salir, en un
   solo bloque, dentro del modal de Novedades. Va ahí y no en la
   tarjeta del muelle porque ese modal se abre desde los DOS
   sitios —la tarjeta del muelle y la tabla de patio— y un
   vehículo que entró directo a patio y se va sin pasar por muelle
   también tiene que poder clasificarse. Si los controles vivieran
   solo en la tarjeta, ese vehículo quedaría encerrado: sin
   tipología no sale, y sin muelle no habría dónde asignársela.

   La tipología la asigna este rol y no la portería: es quien ve
   el vehículo abierto. En la fila de entrada, con el camión
   cerrado, la elección se hacía a ojo — y de ella cuelgan la
   tarifa y las metas de tiempo de toda la bodega.
   ========================================================= */

function bloqueClasificacion(r) {

  if (r.horaSalida) return "";

  const lista = (configBodega && configBodega.tipologias) || [];

  const opciones = ['<option value="">Sin asignar</option>']
    .concat(lista.map((t) =>
      `<option value="${escapar(t.id)}"${t.id === r.tipologia ? " selected" : ""}>${escapar(t.nombre)}</option>`))
    .join("");

  // Sin tipologías configuradas no hay nada que elegir. Se dice en
  // vez de mostrar un desplegable vacío que parecería roto.
  const selector = lista.length
    ? `<select data-set-tipologia="${escapar(r.id)}">${opciones}</select>`
    : '<span class="texto-ayuda">El administrador todavía no ha configurado las tipologías de esta bodega.</span>';

  const falta = !r.tipologia && lista.length
    ? '<div class="cobros-aviso" style="margin-top:10px;"><i class="ti ti-alert-triangle"></i> Sin tipología el vehículo <strong>no puede salir</strong>, y una vez que salga ya no se le puede asignar.</div>'
    : "";

  return `<div class="detail-section-title">Clasificación</div>
          <div class="avance-selector" style="border-top:none;padding-top:0;">
            <span class="avance-label">Tipología del vehículo</span>
            ${selector}
          </div>
          ${selectorModalidad(r)}
          ${falta}`;
}

/* Los botones de la modalidad. Solo aparecen donde la bodega la
   distingue: en las demás sería una pregunta que no cambia nada.
   B9 hoy no la distingue, pero el control va igual — el
   administrador puede encenderla desde Configuración. */
function selectorModalidad(r) {

  if (!distingueModalidad(configBodega)) return "";

  const actual = modalidadDe(r);

  const botones = MODALIDADES.map((m) => {
    const activo = m === actual;
    return `<button class="btn btn-sm ${activo ? "btn-primary" : ""}" data-modalidad="${escapar(r.id)}:${m}">${m}</button>`;
  }).join("");

  // "sin marcar" y no un check: hasta que alguien lo diga, lo que
  // rige es el supuesto, no una confirmación.
  const nota = r.modalidad ? "" : ' <span style="color:var(--text-3);">(sin marcar — se asume arrumado)</span>';

  return `<div class="avance-selector">
            <span class="avance-label">¿Cómo viene la mercancía?${nota}</span>
            <div class="avance-selector-btns">${botones}</div>
          </div>`;
}

async function marcarModalidad(id, modalidad) {
  try {
    await actualizarModalidad(id, modalidad, perfilActual.nombre);
    // El modal se pinta de una sola vez con innerHTML, así que no se
    // entera del cambio por su cuenta: se vuelve a abrir para que los
    // botones y el aviso de "no puede salir" queden al día.
    if (document.getElementById("modal-novedades").classList.contains("open")) openModalNovedades(id);
  } catch (error) {
    console.error("No se pudo marcar la modalidad:", error);
  }
}

async function asignarTipologia(id, tipologiaId) {
  try {
    await actualizarTipologia(id, buscarTipologia(configBodega, tipologiaId), perfilActual.nombre);
    if (document.getElementById("modal-novedades").classList.contains("open")) openModalNovedades(id);
  } catch (error) {
    console.error("No se pudo asignar la tipología:", error);
    alert("No se pudo asignar la tipología. Revisa tu conexión e inténtalo de nuevo.");
  }
}

function nivelMuelle(r) {
  return nivelContraMeta(
    minutosEnMuelle(r),
    tiemposDe(configBodega, r.tipologia, faseActual(r), modalidadDe(r))
  );
}

/* Cuánto lleva en muelle y contra qué meta. Se muestra siempre que
   haya meta, no solo al pasarse: el supervisor necesita ver que va
   en 40 de 105 minutos para saber que va bien, no enterarse solo
   cuando ya es tarde.

   Sin meta lo dice en voz alta: un muelle sin cifra se lee como
   "va bien", y lo que pasa es que ese vehículo no tiene tipología
   asignada — que es justo lo que hay que ir a corregir. */
function avisoMetaMuelle(r) {

  const meta = tiemposDe(configBodega, r.tipologia, faseActual(r), modalidadDe(r));
  const min = minutosEnMuelle(r);

  if (!meta) {
    return '<div class="muelle-meta sin-meta"><i class="ti ti-help-circle"></i> ' +
           formatearMinutos(min) + " en muelle · sin meta (falta tipología)</div>";
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
  if (puedeAutorizarSalidaAnticipada(r, configBodega) && !(r.autorizacionSalida && r.autorizacionSalida.motivo)) {
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

    const btnModalidad = e.target.closest("[data-modalidad]");
    if (btnModalidad) {
      const [idM, modalidad] = btnModalidad.getAttribute("data-modalidad").split(":");
      marcarModalidad(idM, modalidad);
      return;
    }

    // El desplegable de tipología no es un botón: escucha 'change',
    // más abajo. Aquí solo se atrapa el clic para que no se lo lleve
    // ningún otro handler de la lista.
    if (e.target.closest("[data-set-tipologia]")) return;

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

  /* El desplegable de tipología. Va por delegación como los demás:
     el modal se repinta entero cada vez que se abre, así que
     enlazarlo elemento por elemento se perdería en el primer
     repintado. */
  document.body.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-set-tipologia]");
    if (sel) asignarTipologia(sel.getAttribute("data-set-tipologia"), sel.value);
  });
}

function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}

/* =========================================================
   NOVEDADES DEL VEHÍCULO (historial completo, solo lectura)
   ========================================================= */

/* Qué vehículo está mostrando el modal de detalle. Se guarda
   para poder repintarlo cuando llegue un cambio de Firestore:
   el modal se arma de una sola vez con innerHTML y no se entera
   por su cuenta de que el registro que muestra cambió. */
let detalleVehiculoId = null;


/* Repinta el modal de detalle si está abierto. Lo llama la
   suscripción en vivo: sin esto, corregir un registro desde otro
   panel dejaba el detalle mostrando los datos viejos, y el cambio
   solo aparecía al cerrar y volver a abrir. */
function refrescarModalDetalle() {
    if (!detalleVehiculoId) return;
    if (!document.getElementById("modal-novedades").classList.contains("open")) return;
    openModalNovedades(detalleVehiculoId);
}

function openModalNovedades(id) {

    detalleVehiculoId = id;
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

  /* La ficha compartida, la misma que ven el administrador y los
     supervisores de las otras bodegas. Este modal armaba a mano
     cinco filas y se quedaba sin tipología, sin tiempos por
     ubicación, sin el estado del avance y sin cómo vino la
     mercancía: para reconstruir un vehículo había que salir a
     buscar el resto en las tablas.

     Ver el encabezado de detalleVehiculo.js: la ficha vive en un
     solo sitio para que los tres roles lean lo mismo. */
  document.getElementById("modal-novedades-body").innerHTML =
    fichaVehiculo(rec, {
      etiquetas: {
        conductor: etiquetaCampo(configBodega, "conductor"),
        cedula: etiquetaCampo(configBodega, "cedula")
      },
      distingueModalidad: distingueModalidad(configBodega),
      mostrarOperarios: true
    }) +
    bloqueClasificacion(rec) +
    seccionAutorizacion(rec) +
    `<div class="detail-section-title">Novedades</div>${histHtml}`;

  document.getElementById("modal-novedades").classList.add("open");
}

/* =========================================================
   AUTORIZACIÓN DE SALIDA ANTICIPADA

   Ya no es "solo Cargue": cada fase tiene su propio mínimo y cada
   bodega los suyos, configurados por el administrador. Entre el
   mínimo y el 99% el supervisor puede autorizar la salida
   explicando el motivo, que queda grabado en el historial del
   vehículo; por debajo del mínimo no hay excepción, y con el
   mínimo en 100 no hay franja que autorizar.

   En J4 el descargue se autoriza desde el 95% porque no siempre
   se llega al 100%. En J3 y B9 sigue exigiendo el 100%.

   Aquí no se escribe ningún número: el mínimo se le pide a
   minimoDe() con la configuración de la bodega.
   ========================================================= */

function seccionAutorizacion(r) {
  if (r.horaSalida) return "";
  if (!requiereAvanceCompleto(r) || avanceCompleto(r)) return "";

  const pct = r.avancePorcentaje || 0;
  const minimo = minimoDe(r, configBodega);
  const etiqueta = r.avanceTipo === "Cargue" ? "cargue" : "descargue";

  if (r.autorizacionSalida && r.autorizacionSalida.motivo) {
    return `<div class="detail-section-title">Autorización de salida</div>
      <p style="font-size:12.5px;">Autorizada por <strong>${escapar(r.autorizacionSalida.autorizadoPor)}</strong> el ${formatearFecha(r.autorizacionSalida.fecha)}, con ${r.autorizacionSalida.porcentajeAlAutorizar}% de ${etiqueta}.<br>Motivo: ${escapar(r.autorizacionSalida.motivo)}</p>`;
  }

  // Mínimo en 100: esta fase no admite excepción en esta bodega.
  if (minimo >= 100) {
    return `<div class="detail-section-title">Autorización de salida</div>
      <p style="font-size:12.5px;color:#9ca3af;">Este vehículo está en ${etiqueta} (${pct}%) — debe llegar al 100% para poder salir, sin excepción.</p>`;
  }

  if (pct < minimo) {
    return `<div class="detail-section-title">Autorización de salida</div>
      <p style="font-size:12.5px;color:#9ca3af;">El ${etiqueta} está en ${pct}% — debe llegar mínimo al ${minimo}% para poder autorizar una salida anticipada (faltan ${minimo - pct} puntos).</p>`;
  }

  return `<div class="detail-section-title">Autorización de salida</div>
    <p style="font-size:12.5px;color:#854F0B;">El ${etiqueta} está en ${pct}% (no llegó al 100%). Puedes autorizar la salida anticipada explicando el motivo.</p>
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
  // salida: si se preguntara al revés, todos se leerían como
  // despachados normales y la cancelación no se vería en la tabla.
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
    <tr class="${estaCancelado(r) ? "fila-cancelada" : ""}">
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
      <td>
        <button class="btn btn-sm" data-novedades="${r.id}"><i class="ti ti-info-circle"></i></button>
        ${botonCancelar(r)}
      </td>
    </tr>`;
}

/* El botón solo aparece donde hay algo que cancelar: en una bodega
   que maneja cancelaciones y sobre un vehículo que sigue adentro.
   Uno que ya salió no se cancela hacia atrás — su operación se
   hizo, y borrarla sería reescribir el turno. */
function botonCancelar(r) {
  if (!manejaCancelaciones() || r.horaSalida) return "";
  return `<button class="btn btn-sm btn-cancelar" data-cancelar="${escapar(r.id)}" title="Marcar la operación como cancelada">
            <i class="ti ti-ban"></i> Cancelar
          </button>`;
}

function manejaCancelaciones() {
  return !!(configBodega && configBodega.manejaCancelaciones);
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