/* =========================================================
   INLOTRANS — Panel de estadísticas (compartido)

   Supervisor, cliente y administrador muestran las MISMAS
   estadísticas. Hasta ahora cada panel tenía su propia copia de
   este código: tres versiones del mismo cálculo que había que
   corregir tres veces y que, cuando alguna se quedaba atrás,
   hacía que dos pantallas mostraran cifras distintas bajo el
   mismo rótulo. Eso ya pasó con los promedios de tiempo y con el
   umbral de cargue.

   Aquí vive el render completo, una sola vez. Cada panel aporta
   dos cosas:

     1. El HTML con los contenedores que quiera mostrar. Toda
        función de aquí se salta en silencio los contenedores que
        no existan, así que un panel puede traer el bloque
        completo (admin) o solo una parte (cliente, supervisor)
        sin que nada se rompa.

     2. Los registros ya recortados: qué periodo, qué canal. Eso
        sigue siendo decisión del panel, porque cada uno tiene su
        propia barra de filtros.

   Contenedores que reconoce (todos opcionales):

     Tarjetas    es-total, es-salidas, es-promedio,
                 es-promedio-muelle, es-cargue-pct, es-pico,
                 es-total-general, es-promedio-nota,
                 es-promedio-muelle-nota
     Gráficas    chart-entradas-dia, chart-franja-horaria,
                 chart-tipo, chart-operador, chart-tiempo-patio,
                 chart-canal, chart-muelles-general,
                 chart-tiempo-muelle, chart-ontime
     Tablas      ontime-tabla, ontime-top-temprano,
                 ontime-top-tarde, ontime-listado,
                 estad-por-canal-body, estad-por-tipo-body,
                 estad-muelles-operario-body, es-segmentado-body
     Análisis    tend-entradas, tend-patio, tend-perdida,
                 es-perdida-horas, es-perdida-vehiculos,
                 es-perdida-promedio, es-perdida-pct,
                 es-perdida-detalle, es-arbol-body
     Cancelados  es-cancel-total, es-cancel-pct,
                 es-cancel-llego, es-cancel-nollego,
                 es-cancel-motivos
     Tipologías  es-tipologias-body
     Caja        es-caja-total, es-caja-efectivo, es-caja-qr,
                 es-caja-iva, es-caja-cuadrilla, es-caja-inlo,
                 es-caja-facturado, es-caja-pendientes,
                 es-caja-body, es-medio-efectivo, es-medio-qr,
                 es-medio-ambos, es-medio-factura,
                 chart-medios-pago
     Servicio    es-ocupacion-pico, es-capacidad-pct,
                 es-nivel-servicio, es-nivel-detalle
   ========================================================= */

import {
    canalDe,
    clasificarOnTime,
    diaConMasMovimiento,
    getDestino,
    getDiaOperativo,
    getLocationDurations,
    promedioMinutos,
    resumenOnTime
} from "./eventos.js";

import { estaCancelado, llegoAunqueCancelado } from "./vehiculos.js";

import { tiemposDe, modalidadDe } from "./config.js";

import { resumenCaja } from "./cobros.js";

import { diaOperativo, sumarDias } from "../utils/tiempos.js";


const ESTAD_COLORS = {
    azul: "#2563eb", azulClaro: "#93c5fd",
    verde: "#10b981", verdeClaro: "#bbf7d0",
    ambar: "#f59e0b", ambarClaro: "#fde68a",
    teal: "#0d9488", tealClaro: "#99f6e4",
    gris: "#9ca3af"
};

const ONTIME_HEX = { rojo: "#dc2626", amarillo: "#f59e0b", verde: "#10b981" };

/* Meta operativa: un vehículo no debería pasar más de esto
   esperando en patio. Todo minuto por encima es "tiempo perdido".

   Ya NO es una constante. Era 120 fijo aquí, y ese número es
   justamente el que el administrador configura por bodega
   (config.limitePatio): mientras estuvo escrito en el código,
   subir o bajar el límite desde el panel no movía ni la pérdida de
   operación, ni el árbol de oportunidades, ni la tendencia — tres
   indicadores midiendo contra una meta que ya nadie tenía.

   El 120 queda solo como valor de partida, para la bodega que
   todavía no lo tiene configurado y para los paneles que no pasan
   la configuración. */
const META_PATIO_POR_DEFECTO = 120;

let metaPatio = META_PATIO_POR_DEFECTO;

/* Corte del turno. Lo fija el panel en cada render; 6am es el que
   usan las tres bodegas hoy. */
let HORA_CORTE = 6;

/* Registro de gráficas vivas, para destruirlas antes de repintar.
   Es del módulo, no del panel: como solo hay una vista de
   estadísticas abierta a la vez, no hay riesgo de que dos paneles
   se pisen. */
let charts = {};


/* =========================================================
   PUNTO DE ENTRADA

   opts.recs        registros del periodo, ya filtrados por canal
   opts.base        registros filtrados por canal SIN filtro de
                    periodo (para el día pico)
   opts.todos       todos los registros de la operación (para el
                    contador general)
   opts.dias        días operativos del periodo, en orden
   opts.horaCorte   corte del turno (por defecto 6)
   opts.config      configuración de la bodega. De aquí salen la
                    meta de patio, las tipologías con sus metas de
                    muelle, la capacidad y los pesos del nivel de
                    servicio. Sin ella se usa el valor de partida,
                    que es lo que hacían todos los paneles hasta
                    ahora
   opts.cobros      mapa { vehiculoId: cobro } de la bodega. Solo
                    lo tienen supervisor y administrador: las
                    reglas de Firestore no le abren la colección
                    al operario ni al cliente. Sin él, el bloque
                    de caja no se pinta
   ========================================================= */

export function renderPanelEstadisticas(opts) {

    opts = opts || {};
    HORA_CORTE = opts.horaCorte == null ? 6 : opts.horaCorte;

    // La meta de patio de ESTA bodega. `> 0` y no `||` a secas
    // porque un límite en cero significa "sin configurar", y
    // tomarlo al pie de la letra marcaría a todos los vehículos
    // como fuera de meta desde el primer minuto.
    const limite = opts.config && opts.config.limitePatio;
    metaPatio = limite > 0 ? limite : META_PATIO_POR_DEFECTO;

    const recs = opts.recs || [];
    const base = opts.base || recs;
    const todos = opts.todos || base;
    const dias = opts.dias || [];

    /* Un vehículo cancelado no operó. No tardó cero minutos en
       muelle: simplemente no estuvo, y promediarlo con los demás
       baja todos los tiempos de la bodega con visitas que nunca
       ocurrieron. Peor todavía en el cumplimiento de cita: una
       cita cancelada lleva `horaEntrada` igual a la hora de la
       cita, así que puntuaba como llegada perfectamente puntual
       — el indicador premiaba justo lo que no se hizo.

       Por eso todo el desempeño se mide sobre `operativos`. Es la
       regla que ya documenta vehiculos.js; lo que faltaba era
       aplicarla aquí. */
    const operativos = recs.filter((r) => !estaCancelado(r));
    const baseOperativa = base.filter((r) => !estaCancelado(r));
    const todosOperativos = todos.filter((r) => !estaCancelado(r));

    /* ── Tarjetas resumen ── */
    const totalEntradas = operativos.length;
    const totalSalidas = operativos.filter((r) => !!r.horaSalida).length;

    // Los promedios salen de promedioMinutos(), que solo cuenta
    // visitas terminadas y solo las que pasaron por esa ubicación.
    // Ver el comentario en shared/services/eventos.js.
    const promPatio = promedioMinutos(operativos, "patio");
    const promMuelle = promedioMinutos(operativos, "muelle");
    const cargues = operativos.filter((r) => r.tipo === "Cargue" || r.tipo === "Ambos").length;

    setTexto("es-total", totalEntradas);
    setTexto("es-salidas", totalSalidas);
    setTexto("es-promedio", formatearPromedio(promPatio));
    setTexto("es-promedio-muelle", formatearPromedio(promMuelle));
    pintarNotaPromedio("es-promedio-nota", promPatio, "patio");
    pintarNotaPromedio("es-promedio-muelle-nota", promMuelle, "muelle");
    setTexto("es-cargue-pct", totalEntradas ? Math.round((cargues / totalEntradas) * 100) + "%" : "0%");
    setTexto("es-total-general", todosOperativos.length);

    // El día pico se busca en toda la historia, no dentro del
    // periodo: es una referencia, no una medición del periodo.
    const mejorDia = diaConMasMovimiento(baseOperativa, HORA_CORTE);
    setTexto("es-pico", mejorDia ? fmtDiaCorto(mejorDia.dia) + " (" + mejorDia.total + ")" : "—");

    /* ── Análisis: no dependen de Chart.js, van antes del early-return ── */
    renderOnTime(operativos);

    /* Las tres cajas que acompañan al on time. Van aparte de
       renderOnTime() a propósito: esa se sale temprano cuando
       ningún vehículo del periodo traía cita, y el listado
       completo sí tiene que verse en ese caso.

       Sobre `operativos` y no sobre `recs`, igual que la tabla de
       arriba: una cita cancelada se guarda con `horaEntrada` igual
       a la hora de la cita (ver crearCitaCancelada en
       vehiculos.js), así que clasifica con cero minutos de desfase
       y el listado la pintaría en verde, como una llegada
       perfectamente puntual de un camión que nunca llegó. Además
       el pie del listado cuenta vehículos, y con los cancelados
       adentro no cuadraría con la tarjeta "Total de entradas" de
       esta misma pantalla. Lo cancelado tiene su propio bloque. */
    renderTopDesfase("ontime-top-temprano", operativos, -1);
    renderTopDesfase("ontime-top-tarde", operativos, 1);
    renderListadoVehiculos("ontime-listado", operativos);

    const diasPrev = new Set(diasPeriodoAnterior(dias));
    const recsPrev = baseOperativa.filter((r) => diasPrev.has(getDiaOperativo(r, HORA_CORTE)));
    renderTendencias(operativos, recsPrev);
    renderPerdidaOperacion(operativos);
    renderArbolOportunidades(operativos);
    renderTablaSegmentada(operativos);

    /* Los cuatro bloques que miden lo que J4 empezó a capturar:
       lo que se canceló, cómo se comporta cada tipología contra su
       meta, qué entró a la caja y qué tan lleno estuvo el patio. */
    renderCancelaciones(recs, recs.filter((r) => estaCancelado(r)));
    renderTipologias(operativos, opts.config);
    renderCaja(operativos, opts.cobros);
    renderNivelServicio(operativos, dias, opts.config);

    // Las tarjetas y las tablas de arriba ya quedaron listas; las
    // gráficas se reintentan solas en el siguiente render cuando
    // Chart.js termine de cargar.
    if (typeof Chart === "undefined") return;

    /* ── Entradas y salidas por día (entradas divididas Patio/Muelle) ── */
    const salidasPorDia = dias.map((d) => baseOperativa.filter((r) => r.horaSalida && diaOperativo(r.horaSalida, HORA_CORTE) === d).length);
    const entradasPatioPorDia = dias.map((d) => operativos.filter((r) => getDiaOperativo(r, HORA_CORTE) === d && getDestino(r).indexOf("Muelle") !== 0).length);
    const entradasMuellePorDia = dias.map((d) => operativos.filter((r) => getDiaOperativo(r, HORA_CORTE) === d && getDestino(r).indexOf("Muelle") === 0).length);

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
                tooltip: { callbacks: { label: tooltipConPct } },
                datalabels: { display: mostrarSiHayDato, anchor: "end", align: "top", offset: 2, color: "#3A3A38", font: { size: 10, weight: "600" }, formatter: etiquetaConPct }
            },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
        }
    });

    /* ── Franja horaria ── */
    renderChartFranjaHoraria("chart-franja-horaria", operativos, HORA_CORTE);

    /* ── Tipo de operación ── */
    const soloCargue = operativos.filter((r) => r.tipo === "Cargue").length;
    const soloDescargue = operativos.filter((r) => r.tipo === "Descargue").length;
    const ambos = operativos.filter((r) => r.tipo === "Ambos").length;
    renderChart("chart-tipo", {
        type: "doughnut",
        data: { labels: ["Cargue", "Descargue", "Ambos"], datasets: [{ data: [soloCargue, soloDescargue, ambos], backgroundColor: [ESTAD_COLORS.azul, ESTAD_COLORS.ambar, ESTAD_COLORS.teal] }] },
        options: { plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: tooltipConPct } }, datalabels: { display: mostrarSiHayDato, color: "#fff", font: { size: 11, weight: "700" }, formatter: etiquetaConPct } } }
    });

    /* ── Por operador ── */
    const porOperador = {};
    operativos.forEach((r) => { const op = r.operadorEntrada || "—"; porOperador[op] = (porOperador[op] || 0) + 1; });
    const opLabels = Object.keys(porOperador).sort((a, b) => porOperador[b] - porOperador[a]);
    renderChart("chart-operador", {
        type: "bar",
        data: { labels: opLabels, datasets: [{ label: "Vehículos atendidos", data: opLabels.map((k) => porOperador[k]), backgroundColor: ESTAD_COLORS.teal, borderRadius: 4 }] },
        options: { indexAxis: "y", layout: { padding: { right: 52 } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: tooltipConPct } }, datalabels: { display: mostrarSiHayDato, anchor: "end", align: "right", color: "#3A3A38", font: { size: 10, weight: "600" }, formatter: etiquetaConPct } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
    });

    /* ── Tiempo promedio en patio por día ── */
    // null (no 0) en los días sin vehículos terminados: un cero
    // dibuja una caída a fondo que se lee como "ese día salieron
    // al instante", cuando lo que pasa es que no hay dato.
    const tiempoPorDia = dias.map((d) =>
        promedioMinutos(operativos.filter((r) => getDiaOperativo(r, HORA_CORTE) === d), "patio").promedio
    );
    renderChart("chart-tiempo-patio", {
        type: "line",
        data: { labels: dias.map(fmtDiaCorto), datasets: [{ label: "Tiempo promedio", data: tiempoPorDia, borderColor: ESTAD_COLORS.ambar, backgroundColor: "rgba(245,158,11,0.15)", fill: true, tension: 0.3, pointRadius: 3 }] },
        options: {
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => formatearMinutos(ctx.raw) } },
                datalabels: { display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0, align: "top", color: "#854F0B", font: { size: 10, weight: "600" }, formatter: (v) => formatearMinutos(v) }
            },
            scales: { y: ejeTiempo() }
        }
    });

    /* ── Por canal ── */
    const porCanal = {};
    operativos.forEach((r) => { const c = canalDe(r); porCanal[c] = (porCanal[c] || 0) + 1; });
    const canalLabels = Object.keys(porCanal);
    renderChart("chart-canal", {
        type: "bar",
        data: { labels: canalLabels, datasets: [{ label: "Vehículos", data: canalLabels.map((k) => porCanal[k]), backgroundColor: ESTAD_COLORS.azulClaro, borderRadius: 4 }] },
        options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: tooltipConPct } }, datalabels: { display: mostrarSiHayDato, anchor: "end", align: "top", color: "#3A3A38", font: { size: 10, weight: "600" }, formatter: etiquetaConPct } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });

    /* ── Muelles más usados ── */
    const porMuelle = {};
    operativos.forEach((r) => {
        const dest = getDestino(r);
        if (dest.indexOf("Muelle") !== 0) return;
        porMuelle[dest] = (porMuelle[dest] || 0) + 1;
    });
    const muelleLabels = Object.keys(porMuelle).sort((a, b) => porMuelle[b] - porMuelle[a]);
    renderChart("chart-muelles-general", {
        type: "bar",
        data: { labels: muelleLabels, datasets: [{ label: "Veces usado", data: muelleLabels.map((k) => porMuelle[k]), backgroundColor: ESTAD_COLORS.teal, borderRadius: 4 }] },
        options: { indexAxis: "y", layout: { padding: { right: 52 } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: tooltipConPct } }, datalabels: { display: mostrarSiHayDato, anchor: "end", align: "right", color: "#3A3A38", font: { size: 10, weight: "600" }, formatter: etiquetaConPct } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
    });

    /* ── Tiempo promedio en muelle por día ── */
    const muellePorDia = dias.map((d) =>
        promedioMinutos(operativos.filter((r) => getDiaOperativo(r, HORA_CORTE) === d), "muelle").promedio
    );
    renderChart("chart-tiempo-muelle", {
        type: "line",
        data: { labels: dias.map(fmtDiaCorto), datasets: [{ label: "Tiempo promedio", data: muellePorDia, borderColor: ESTAD_COLORS.teal, backgroundColor: "rgba(13,148,136,0.15)", fill: true, tension: 0.3, pointRadius: 3 }] },
        options: {
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => formatearMinutos(ctx.raw) } },
                datalabels: { display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0, align: "top", color: "#0d5a52", font: { size: 10, weight: "600" }, formatter: (v) => formatearMinutos(v) }
            },
            scales: { y: ejeTiempo() }
        }
    });

    /* ── Tablas ── */
    renderTablaPorCanal(operativos, canalLabels);
    renderTablaPorTipo(operativos);
    renderTablaMuellesPorOperario(operativos);
}


/* =========================================================
   ETIQUETAS CON PORCENTAJE

   Toda gráfica de conteo rotula el número y su peso sobre el
   total: "12" no dice si eso es mucho o poco, "12 (30%)" sí. El
   total se calcula sobre los datos que la gráfica está pintando,
   que son los del periodo elegido, así que el porcentaje se
   mueve con el filtro de fechas como el resto del panel.

   Es el total de la SERIE, no el de la gráfica entera. En las de
   una sola serie son la misma cifra. En las de varias (entradas
   por día, franja horaria) lo que se quiere leer es el día o la
   hora contra su propia serie — "el 15% de las entradas a patio
   del periodo fueron ese día" —, no contra la suma de series que
   miden cosas distintas.

   Las dos gráficas de tiempo promedio quedan fuera a propósito:
   sus valores son promedios en minutos, y el porcentaje de un
   promedio sobre la suma de los promedios de los otros días no
   significa nada.
   ========================================================= */

function totalSerie(ctx) {
    return (ctx.dataset.data || []).reduce((a, v) => a + (Number(v) || 0), 0);
}

function pctSerie(valor, ctx) {
    const total = totalSerie(ctx);
    return total ? Math.round(((Number(valor) || 0) / total) * 100) : 0;
}

function etiquetaConPct(valor, ctx) {
    const total = totalSerie(ctx);
    return total ? valor + " (" + pctSerie(valor, ctx) + "%)" : String(valor);
}

/* "auto" en vez de true: con el porcentaje al lado la etiqueta
   mide casi el doble, y en un periodo largo o en las barras
   apiladas de la franja horaria se pisarían unas con otras hasta
   volverse ilegibles. Así el plugin esconde la que no cabe; el
   dato completo sigue estando en el tooltip, que nunca se
   esconde. */
function mostrarSiHayDato(ctx) {
    return ctx.dataset.data[ctx.dataIndex] > 0 ? "auto" : false;
}

/* El tooltip lleva siempre número y porcentaje, quepa o no la
   etiqueta sobre la barra. En la dona no hay nombre de serie y el
   título del tooltip ya trae el de la porción, así que ahí se
   queda solo la cifra en vez de repetirlo. */
function tooltipConPct(ctx) {
    const serie = ctx.dataset.label ? ctx.dataset.label + ": " : "";
    return serie + ctx.raw + " (" + pctSerie(ctx.raw, ctx) + "%)";
}


/* Escribe en un contenedor solo si existe: cada panel decide qué
   tarjetas muestra, y las que no traiga simplemente no se pintan. */
function setTexto(id, valor) {
    const el = document.getElementById(id);
    if (el) el.textContent = valor;
}

/* =========================================================
   FRANJA HORARIA — compartida entre Dashboard y Estadísticas

   Misma construcción de datos y mismas opciones de Chart.js en
   los dos lugares (apiladas por canal: 3PD / MQ / Otros), para
   que la gráfica se vea y se comporte exactamente igual — solo
   cambia qué lista de registros se le pasa (hoy vs. el periodo
   elegido en Estadísticas).
   ========================================================= */

function datosFranjaHoraria(registros, horaCorte) {
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
    const h = (horaCorte + i) % 24;
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

export function renderChartFranjaHoraria(canvasId, registros, horaCorte) {
  if (typeof Chart === "undefined") return;
  const { labels, datasets } = datosFranjaHoraria(registros, horaCorte == null ? HORA_CORTE : horaCorte);

  renderChart(canvasId, {
    type: "bar",
    data: { labels, datasets },
    options: {
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: tooltipConPct } },
        datalabels: { display: mostrarSiHayDato, anchor: "center", align: "center", color: "#2B2B29", font: { size: 9, weight: "600" }, formatter: etiquetaConPct }
      },
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}

function fmtDiaCorto(diaOp) {
  return new Date(diaOp + "T00:00:00").toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit" });
}

export function renderChart(canvasId, config) {
  const ctx = document.getElementById(canvasId);
  if (!ctx || typeof Chart === "undefined") return;
  destruirSiExiste(canvasId);
  charts[canvasId] = new Chart(ctx, config);
}

export function destruirSiExiste(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function renderTablaPorCanal(recs, canalLabels) {
  const cont = document.getElementById("estad-por-canal-body");
  if (!cont) return;
  if (!canalLabels.length) {
    cont.innerHTML = '<div class="texto-ayuda">No hay datos para el periodo.</div>';
    return;
  }
  let html = '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Canal</th><th>Promedio patio</th><th># Vehículos</th><th>Finalizados</th></tr></thead><tbody>';
  let descartadas = 0, sinPaso = 0;
  canalLabels.forEach((k) => {
    const grupo = recs.filter((r) => canalDe(r) === k);
    const prom = promedioMinutos(grupo, "patio");
    descartadas += prom.descartadas;
    sinPaso += prom.sinPaso;
    html += `<tr><td>${escapar(k)}</td><td>${celdaPromedio(prom)}</td><td>${grupo.length}</td><td>${finalizadosDe(prom)}</td></tr>`;
  });
  html += "</tbody></table></div>";
  html += notaPromedios(descartadas, sinPaso);
  cont.innerHTML = html;
}

function renderTablaPorTipo(recs) {
  const cont = document.getElementById("estad-por-tipo-body");
  if (!cont) return;
  const tipos = ["Cargue", "Descargue", "Ambos"];
  let html = '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Tipo</th><th>Promedio patio</th><th>Promedio muelle</th><th># Vehículos</th><th>Finalizados</th></tr></thead><tbody>';
  let descartadas = 0, sinPaso = 0;
  tipos.forEach((t) => {
    const grupo = recs.filter((r) => r.tipo === t);
    const promP = promedioMinutos(grupo, "patio");
    const promM = promedioMinutos(grupo, "muelle");
    descartadas += promP.descartadas;
    sinPaso += promP.sinPaso;
    html += `<tr><td>${t}</td><td>${celdaPromedio(promP)}</td><td>${celdaPromedio(promM)}</td><td>${grupo.length}</td><td>${finalizadosDe(promP)}</td></tr>`;
  });
  html += "</tbody></table></div>";
  html += notaPromedios(descartadas, sinPaso);
  cont.innerHTML = html;
}

/* Eje vertical de las gráficas de tiempo: los valores se guardan en
   minutos, pero se rotulan en horas y minutos. Sin esto, "138" en el
   eje hay que dividirlo mentalmente para saber que son 2h 18m.

   `precision: 0` evita que Chart.js invente marcas decimales cuando
   el rango es pequeño (0,1 · 0,2 · 0,3…), que con este formato se
   verían todas como "0 min". El guardia de Number.isInteger es por si
   alguna aun así se cuela. */
function ejeTiempo() {
  return {
    beginAtZero: true,
    ticks: {
      precision: 0,
      callback: (v) => (Number.isInteger(v) ? formatearMinutos(v) : "")
    }
  };
}

function formatearMinutos(min) {
  const m = Math.round(min);
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

/* Pesos enteros: las tarifas de portería no usan centavos y
   arrastrarlos solo ensucia el arqueo. Mismo formato que usa el
   panel de cobros del supervisor. */
function fmtMoneda(valor) {
  return "$" + Math.round(Number(valor) || 0).toLocaleString("es-CO");
}

/* Resultado de promedioMinutos(): "—" cuando no hubo ninguna
   visita terminada con la cual promediar. */
function formatearPromedio(p) {
  return p && p.promedio !== null ? formatearMinutos(p.promedio) : "—";
}

/* Debajo de la tarjeta de promedio: sobre cuántos vehículos se calculó,
   o por qué no hay cifra. Sin esto, un "—" parece un error del panel y
   un "1h 40m" sacado de un solo vehículo se lee como el dato del turno. */
function pintarNotaPromedio(id, p, ubicacion) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = p.promedio === null
    ? "Ningún vehículo terminado pasó por " + ubicacion + " en el periodo"
    : "sobre " + p.n + " vehículo(s) que ya salieron";
}

/* Todas las visitas terminadas del grupo, hayan entrado o no al
   promedio. n = las que sí; sinPaso = las que no pasaron por esa
   ubicación; descartadas = las que no se pudieron medir. */
function finalizadosDe(p) {
  return p ? p.n + p.sinPaso + p.descartadas : 0;
}

/* Celda de promedio con el tamaño de la muestra al lado: un
   promedio de 3h sobre 1 vehículo no dice lo mismo que sobre 40, y
   sin el (n) las dos cifras se ven idénticas en la tabla. */
function celdaPromedio(p) {
  return formatearPromedio(p) + ' <span class="prom-n">(' + (p ? p.n : 0) + ')</span>';
}

/* Pie de las tablas de promedios: deja explícito a quién se contó.
   `sinPaso` son los que no pasaron por esa ubicación (una entrada
   directa a muelle no "esperó 0 minutos en patio", no estuvo en
   patio) y `descartadas` los que promedioMinutos() no pudo medir.
   Ambos se dicen en voz alta en vez de disolverse en la cifra. */
function notaPromedios(descartadas, sinPaso) {
  return '<p class="texto-ayuda" style="margin-top:8px;">Los promedios cuentan solo los vehículos que ya salieron ' +
    'y que efectivamente pasaron por esa ubicación: los que siguen adentro tienen el tiempo corriendo y ' +
    'moverían la cifra en cada actualización.' +
    (sinPaso ? ' ' + sinPaso + ' vehículo(s) entraron directo a muelle y no cuentan en el promedio de patio.' : '') +
    (descartadas
      ? ' Otros ' + descartadas + ' quedaron fuera por no tener tiempos utilizables: historial incompleto, ' +
        'o una hora de salida anterior al último cambio de ubicación.'
      : '') +
    '</p>';
}

function escapar(txt) {
  return String(txt == null ? "" : txt).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}


/* =========================================================
   ANÁLISIS: TENDENCIAS, PÉRDIDA DE OPERACIÓN Y OPORTUNIDADES

   La meta operativa es que un vehículo no pase más de
   `metaPatio` esperando en patio — el límite que el
   administrador configura para ESA bodega. Todo minuto por
   encima de esa meta es "tiempo perdido": no es que el dato
   esté malo, es capacidad de la bodega que se fue en espera.
   Sobre esa idea se construyen los tres bloques:

     - Pérdida de operación: cuánto se perdió y a cuántos
       vehículos les pasó.
     - Árbol de oportunidades: dónde se concentra esa pérdida
       (primero por canal, y dentro de cada canal por tipo de
       operación), para saber qué atacar primero.
     - Tendencias: si vamos mejor o peor que el periodo
       inmediatamente anterior del mismo tamaño.
   ========================================================= */

function excesoDe(r) {
  return Math.max(0, (getLocationDurations(r).patio || 0) - metaPatio);
}

/* Misma población que el resto de los tiempos del panel: solo
   visitas terminadas. Contar aquí a los vehículos que siguen en
   patio hacía que la cifra creciera sola entre repintados y que la
   tendencia comparara un periodo en curso contra uno ya cerrado —
   el porcentaje cambiaba según la hora a la que se abriera el
   panel. La espera de los que están adentro ahora mismo se ve en el
   Dashboard (vehículos en alerta), que es donde corresponde. */
function calcularPerdida(recs) {
  const universo = recs.filter((r) => r.horaSalida);
  const afectados = universo.filter((r) => excesoDe(r) > 0);
  const totalMin = afectados.reduce((a, r) => a + excesoDe(r), 0);
  let peor = null;
  afectados.forEach((r) => { if (!peor || excesoDe(r) > excesoDe(peor)) peor = r; });
  return {
    totalMin,
    vehiculos: afectados.length,
    promedio: afectados.length ? Math.round(totalMin / afectados.length) : 0,
    porcentaje: universo.length ? Math.round((afectados.length / universo.length) * 100) : 0,
    peor
  };
}

function renderPerdidaOperacion(recs) {
  const p = calcularPerdida(recs);
  const horas = (p.totalMin / 60).toFixed(1);

  setTexto("es-perdida-horas", horas + " h");
  setTexto("es-perdida-vehiculos", p.vehiculos);
  setTexto("es-perdida-promedio", formatearMinutos(p.promedio));
  setTexto("es-perdida-pct", p.porcentaje + "%");

  const cont = document.getElementById("es-perdida-detalle");
  if (!cont) return;

  if (!p.vehiculos) {
    cont.innerHTML = '<div class="texto-ayuda">Ningún vehículo superó la meta de ' +
      formatearMinutos(metaPatio) + ' en patio durante el periodo. Sin pérdida registrada.</div>';
    return;
  }
  cont.innerHTML = '<div class="texto-ayuda">Meta: ' + formatearMinutos(metaPatio) +
    ' en patio. El caso más largo fue <strong>' + escapar(p.peor.placa) + '</strong>, con ' +
    formatearMinutos(excesoDe(p.peor)) + ' por encima de la meta.</div>';
}

/* Árbol: canal → tipo de operación, ordenado por cuánto pesa
   cada rama sobre el total perdido. */
function renderArbolOportunidades(recs) {
  const cont = document.getElementById("es-arbol-body");
  if (!cont) return;
  const p = calcularPerdida(recs);

  if (!p.totalMin) {
    cont.innerHTML = '<div class="texto-ayuda">No hay tiempo perdido que analizar en este periodo.</div>';
    return;
  }

  const porCanal = {};
  recs.forEach((r) => {
    const ex = excesoDe(r);
    if (!ex) return;
    const canal = canalDe(r);
    const tipo = r.tipo || "—";
    if (!porCanal[canal]) porCanal[canal] = { total: 0, n: 0, tipos: {} };
    porCanal[canal].total += ex;
    porCanal[canal].n += 1;
    if (!porCanal[canal].tipos[tipo]) porCanal[canal].tipos[tipo] = { total: 0, n: 0 };
    porCanal[canal].tipos[tipo].total += ex;
    porCanal[canal].tipos[tipo].n += 1;
  });

  const canales = Object.keys(porCanal).sort((a, b) => porCanal[b].total - porCanal[a].total);

  let html = '<div class="arbol">';
  canales.forEach((canal) => {
    const c = porCanal[canal];
    const pct = Math.round((c.total / p.totalMin) * 100);
    html += `
      <div class="arbol-rama">
        <div class="arbol-nodo">
          <span class="arbol-nombre">${escapar(canal)}</span>
          <span class="arbol-cifra">${(c.total / 60).toFixed(1)} h · ${c.n} veh.</span>
        </div>
        <div class="arbol-barra"><span style="width:${pct}%"></span></div>
        <div class="arbol-pct">${pct}% de la pérdida total</div>`;

    const tipos = Object.keys(c.tipos).sort((a, b) => c.tipos[b].total - c.tipos[a].total);
    tipos.forEach((t) => {
      const d = c.tipos[t];
      const pctT = Math.round((d.total / c.total) * 100);
      html += `
        <div class="arbol-hoja">
          <span>${escapar(t)}</span>
          <span>${(d.total / 60).toFixed(1)} h · ${pctT}% del canal</span>
        </div>`;
    });
    html += "</div>";
  });
  html += "</div>";
  cont.innerHTML = html;
}

/* Compara el periodo actual contra el inmediatamente anterior
   del mismo número de días. En los tiempos, bajar es mejorar. */
function diasPeriodoAnterior(dias) {
  if (!dias.length) return [];
  const prev = [];
  for (let i = dias.length; i >= 1; i--) prev.push(sumarDias(dias[0], -i));
  return prev;
}

function promedioPatio(recs) {
  // Misma regla que las tarjetas y las tablas: solo terminados y
  // solo los que pasaron por patio.
  return promedioMinutos(recs, "patio").promedio || 0;
}

function renderTendencias(recsActual, recsPrevio) {
  const filas = [
    { id: "tend-entradas", actual: recsActual.length, previo: recsPrevio.length, menorEsMejor: false, fmt: (v) => v },
    { id: "tend-patio", actual: promedioPatio(recsActual), previo: promedioPatio(recsPrevio), menorEsMejor: true, fmt: formatearMinutos },
    { id: "tend-perdida", actual: Math.round(calcularPerdida(recsActual).totalMin / 6) / 10,
      previo: Math.round(calcularPerdida(recsPrevio).totalMin / 6) / 10, menorEsMejor: true, fmt: (v) => v + " h" }
  ];

  filas.forEach((f) => {
    const cont = document.getElementById(f.id);
    if (!cont) return;
    const dif = f.actual - f.previo;
    let clase = "tend-igual", icono = "ti-minus", texto = "igual que el periodo anterior";

    if (f.previo === 0 && f.actual === 0) {
      // se queda en "igual"
    } else if (dif !== 0) {
      const pct = f.previo ? Math.abs(Math.round((dif / f.previo) * 100)) : 100;
      const subio = dif > 0;
      const bueno = f.menorEsMejor ? !subio : subio;
      clase = bueno ? "tend-bien" : "tend-mal";
      icono = subio ? "ti-trending-up" : "ti-trending-down";
      texto = `${subio ? "+" : "−"}${pct}% vs. periodo anterior`;
    }
    cont.className = "tend-delta " + clase;
    cont.innerHTML = `<i class="ti ${icono}"></i> ${texto}`;
    const valor = document.getElementById(f.id + "-valor");
    if (valor) valor.textContent = f.fmt(f.actual);
  });
}

/* Segmentación pedida en el brief: tiempos de cargue y descargue
   en patio Y en muelle, abiertos por canal. */
function renderTablaSegmentada(recs) {
  const cont = document.getElementById("es-segmentado-body");
  if (!cont) return;
  const canales = Array.from(new Set(recs.map(canalDe))).sort();
  const tipos = ["Cargue", "Descargue", "Ambos"];

  if (!recs.length) {
    cont.innerHTML = '<div class="texto-ayuda">No hay datos para el periodo.</div>';
    return;
  }

  let html = '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Canal</th><th>Tipo</th><th># Veh.</th><th>Finalizados</th><th>Prom. patio</th><th>Prom. muelle</th><th>Total en planta</th></tr></thead><tbody>';
  let descartadas = 0, sinPaso = 0;
  canales.forEach((canal) => {
    tipos.forEach((tipo) => {
      const g = recs.filter((r) => canalDe(r) === canal && r.tipo === tipo);
      if (!g.length) return;
      const pp = promedioMinutos(g, "patio");
      const pm = promedioMinutos(g, "muelle");
      descartadas += pp.descartadas;
      sinPaso += pp.sinPaso;
      // "Total en planta" suma los dos promedios, así que solo tiene
      // sentido cuando ambos existen: si nadie de este grupo pasó por
      // patio, sumar su promedio inexistente daría una cifra inventada.
      const total = pp.n && pm.n ? formatearMinutos(pp.promedio + pm.promedio) : "—";
      html += `<tr><td>${escapar(canal)}</td><td>${tipo}</td><td>${g.length}</td><td>${finalizadosDe(pp)}</td><td>${celdaPromedio(pp)}</td><td>${celdaPromedio(pm)}</td><td>${total}</td></tr>`;
    });
  });
  html += "</tbody></table></div>";
  html += notaPromedios(descartadas, sinPaso);
  cont.innerHTML = html;
}

function renderTablaMuellesPorOperario(recs) {
  const cont = document.getElementById("estad-muelles-operario-body");
  if (!cont) return;
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

  let html = '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Operario</th><th>Muelle más usado</th><th>Veces</th><th>Total usos de muelle</th></tr></thead><tbody>';
  operarios.forEach((op) => {
    const muelles = porOperarioMuelle[op];
    const muelleKeys = Object.keys(muelles).sort((a, b) => muelles[b] - muelles[a]);
    const top = muelleKeys[0];
    const totalOp = muelleKeys.reduce((s, k) => s + muelles[k], 0);
    html += `<tr><td>${escapar(op)}</td><td>${escapar(top)}</td><td>${muelles[top]}</td><td>${totalOp}</td></tr>`;
  });
  html += "</tbody></table></div>";
  cont.innerHTML = html;
}

/* =========================================================
   CANCELACIONES

   Los cancelados salen de todos los indicadores de desempeño
   (ver el comentario en renderPanelEstadisticas), y por eso
   mismo necesitan un cuadro propio: un vehículo que se descuenta
   de los promedios y no aparece en ninguna parte es un vehículo
   que desaparece del reporte.

   El porcentaje se calcula sobre TODO lo que se esperaba
   —operados más cancelados—, que es el universo contra el que la
   cifra significa algo: "de 100 vehículos que se esperaban, 12
   no operaron".
   ========================================================= */

function renderCancelaciones(recs, cancelados) {

  const total = cancelados.length;
  const llego = cancelados.filter((r) => llegoAunqueCancelado(r)).length;

  setTexto("es-cancel-total", total);
  setTexto("es-cancel-pct", recs.length ? Math.round((total / recs.length) * 100) + "%" : "0%");
  setTexto("es-cancel-llego", llego);
  setTexto("es-cancel-nollego", total - llego);

  const cont = document.getElementById("es-cancel-motivos");
  if (!cont) return;

  if (!total) {
    cont.innerHTML = '<div class="texto-ayuda">Ninguna operación se canceló en el periodo.</div>';
    return;
  }

  // Los motivos los escribe una persona a mano, así que se agrupan
  // normalizando espacios y mayúsculas. No es perfecto —"no llegó"
  // y "no llego" siguen siendo dos— pero junta lo evidente sin
  // inventar categorías que nadie definió.
  const porMotivo = {};
  cancelados.forEach((r) => {
    const bruto = ((r.cancelacion && r.cancelacion.motivo) || "Sin motivo registrado").trim();
    const clave = bruto.toLowerCase().replace(/\s+/g, " ");
    if (!porMotivo[clave]) porMotivo[clave] = { texto: bruto, n: 0 };
    porMotivo[clave].n += 1;
  });

  const claves = Object.keys(porMotivo).sort((a, b) => porMotivo[b].n - porMotivo[a].n);

  let html = '<table class="tabla"><thead><tr><th>Motivo</th><th>Veces</th><th>% de las cancelaciones</th></tr></thead><tbody>';
  claves.forEach((k) => {
    const m = porMotivo[k];
    html += `<tr><td>${escapar(m.texto)}</td><td>${m.n}</td><td>${Math.round((m.n / total) * 100)}%</td></tr>`;
  });
  html += "</tbody></table>";
  html += '<p class="texto-ayuda" style="margin-top:8px;">Los cancelados no entran en ningún promedio de tiempo ' +
    "ni en el cumplimiento de cita: no operaron, así que no tienen tiempos que promediar.</p>";
  cont.innerHTML = html;
}


/* =========================================================
   TIPOLOGÍAS CONTRA SU META DE MUELLE

   Cada tipología lleva una meta de tiempo en muelle POR TIPO DE
   OPERACIÓN: una tractomula que descarga no debería tardar lo
   mismo que una que carga. Por eso el cumplimiento se decide
   vehículo por vehículo —con la meta que le corresponde a SU
   operación— y solo después se agrupa por tipología. Una sola
   meta por fila sería mentira en cuanto la tipología tenga
   cargues y descargues mezclados.

   `tiemposDe()` devuelve null cuando la tipología no tiene meta
   configurada para esa operación. Esos vehículos cuentan en el
   promedio pero no en el cumplimiento: no se puede incumplir una
   meta que nadie fijó.

   La fila "Sin tipología" no es relleno: son los vehículos que no
   se pueden cobrar ni medir, y verlos contados es lo que hace que
   alguien los asigne.
   ========================================================= */

/*
    Contra qué meta se midió la fila. Una tipología puede haber
    medido contra varias en el mismo periodo: la de cargue, la de
    descargue y la derivada de "Ambos" son tres números distintos y
    los tres son legítimos. Mostrar un solo valor sería mentir, así
    que cuando hay varias se dice el rango — el detalle de cuál le
    tocó a cada vehículo está en su ficha.
*/
function textoMetas(metas) {
    if (!metas || !metas.length) return "—";
    if (metas.length === 1) return formatearMinutos(metas[0]);
    const orden = metas.slice().sort((a, b) => a - b);
    return formatearMinutos(orden[0]) + " a " + formatearMinutos(orden[orden.length - 1]);
}

function renderTipologias(recs, config) {

  const cont = document.getElementById("es-tipologias-body");
  if (!cont) return;

  if (!recs.length) {
    cont.innerHTML = '<div class="texto-ayuda">No hay datos para el periodo.</div>';
    return;
  }

  const grupos = {};

  recs.forEach((r) => {

    const nombre = r.tipologiaNombre || "Sin tipología";
    if (!grupos[nombre]) grupos[nombre] = { n: 0, terminados: 0, conMeta: 0, enMeta: 0, minutos: 0, metas: [] };

    const g = grupos[nombre];
    g.n += 1;

    // Solo lo terminado se mide, igual que el resto del panel: un
    // vehículo que sigue en muelle tiene el tiempo corriendo.
    if (!r.horaSalida) return;
    g.terminados += 1;

    const enMuelle = getLocationDurations(r).muelle || 0;
    g.minutos += enMuelle;

    // La modalidad entra en la meta: la misma tipología arrumada y
    // paletizada son dos metas distintas, y medir las dos contra la
    // de arrumado marcaría como incumplidos a todos los paletizados.
    const meta = config ? tiemposDe(config, r.tipologia, r.tipo, modalidadDe(r)) : null;
    if (!meta) return;

    g.conMeta += 1;
    if (g.metas.indexOf(meta.meta) === -1) g.metas.push(meta.meta);
    if (enMuelle <= meta.meta) g.enMeta += 1;
  });

  const nombres = Object.keys(grupos).sort((a, b) => grupos[b].n - grupos[a].n);

  let html = '<table class="tabla"><thead><tr><th>Tipología</th><th># Veh.</th><th>Finalizados</th>' +
    "<th>Meta</th><th>Prom. muelle</th><th>Con meta</th><th>Dentro de meta</th><th>% cumplimiento</th></tr></thead><tbody>";

  let sinMeta = 0;

  nombres.forEach((nombre) => {
    const g = grupos[nombre];
    sinMeta += g.terminados - g.conMeta;
    const prom = g.terminados ? formatearMinutos(g.minutos / g.terminados) : "—";
    const pct = g.conMeta ? Math.round((g.enMeta / g.conMeta) * 100) + "%" : "—";
    html += `<tr><td>${escapar(nombre)}</td><td>${g.n}</td><td>${g.terminados}</td>` +
      `<td>${textoMetas(g.metas)}</td>` +
      `<td>${prom}</td><td>${g.conMeta}</td><td>${g.enMeta}</td><td>${pct}</td></tr>`;
  });

  html += "</tbody></table>";
  html += '<p class="texto-ayuda" style="margin-top:8px;">La meta de muelle la fija el administrador por tipología ' +
    "y por tipo de operación, así que el cumplimiento se evalúa vehículo por vehículo con la meta de SU operación." +
    (sinMeta
      ? " " + sinMeta + " vehículo(s) finalizados quedaron fuera del cumplimiento porque su tipología todavía no " +
        "tiene meta configurada para esa operación."
      : "") +
    "</p>";

  cont.innerHTML = html;
}


/* =========================================================
   CAJA DEL PERIODO

   Solo se pinta donde llegan los cobros, y los cobros solo los
   recibe quien puede leerlos: supervisor y administrador. El
   panel del cliente no pasa `opts.cobros` y aquí no se pinta
   nada — no es que se oculte en pantalla, es que el dato no
   viaja. Ver el encabezado de cobros.js.

   Lo facturado al cliente va aparte del recaudo y NO se suma:
   esa plata no pasó por la caja de portería, y meterla en el
   total descuadraría el arqueo del turno.
   ========================================================= */

function renderCaja(recs, cobros) {

  if (!cobros) return;

  const lista = recs.map((r) => cobros[r.id]).filter(Boolean);
  const c = resumenCaja(lista);

  setTexto("es-caja-total", fmtMoneda(c.total));
  setTexto("es-caja-efectivo", fmtMoneda(c.totalEfectivo));
  setTexto("es-caja-qr", fmtMoneda(c.totalQR));
  setTexto("es-caja-iva", fmtMoneda(c.totalIva));
  setTexto("es-caja-cuadrilla", fmtMoneda(c.totalCuadrilla));
  setTexto("es-caja-inlo", fmtMoneda(c.gananciaInlo));
  setTexto("es-caja-facturado", fmtMoneda(c.totalFacturado));

  // Cuántos vehículos del periodo se quedaron sin cobrar. Los que
  // no tienen tipología no entran: su bloqueo se resuelve
  // asignándosela, no cobrando (misma regla que pendientesDeCobro).
  const cobrables = recs.filter((r) => r.tipologia);
  setTexto("es-caja-pendientes", cobrables.filter((r) => !cobros[r.id]).length);

  /* Cuántos VEHÍCULOS pagó cada medio, no cuánta plata. Son dos
     preguntas distintas y la de arriba solo responde la segunda:
     un solo camión con tarifa alta puede pesar más en el monto que
     diez que pagaron en efectivo, y eso no dice nada sobre cuánta
     gente llega con QR. "Ambos" es su propia casilla, no la suma
     de las otras dos — ver el encabezado de cobros.js. */
  setTexto("es-medio-efectivo", c.porMedio.Efectivo.n);
  setTexto("es-medio-qr", c.porMedio.QR.n);
  setTexto("es-medio-ambos", c.porMedio.Ambos.n);
  setTexto("es-medio-factura", c.porMedio.Factura.n);

  renderChart("chart-medios-pago", {
    type: "doughnut",
    data: {
      labels: ["Efectivo", "QR", "Ambos", "Facturado"],
      datasets: [{
        data: [c.porMedio.Efectivo.n, c.porMedio.QR.n, c.porMedio.Ambos.n, c.porMedio.Factura.n],
        backgroundColor: [ESTAD_COLORS.verde, ESTAD_COLORS.azul, ESTAD_COLORS.ambar, ESTAD_COLORS.gris]
      }]
    },
    options: {
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const medio = ["Efectivo", "QR", "Ambos", "Factura"][ctx.dataIndex];
              return ctx.raw + " vehículo(s) · " + fmtMoneda(c.porMedio[medio].monto);
            }
          }
        },
        datalabels: {
          display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0,
          color: "#fff", font: { size: 11, weight: "700" }, formatter: (v) => v
        }
      }
    }
  });

  const cont = document.getElementById("es-caja-body");
  if (!cont) return;

  if (!c.vehiculos) {
    cont.innerHTML = '<div class="texto-ayuda">No se registró ningún cobro en el periodo.</div>';
    return;
  }

  let html = '<table class="tabla"><thead><tr><th>Soporte</th><th>Vehículos</th><th>Monto</th></tr></thead><tbody>';
  Object.keys(c.porSoporte).forEach((s) => {
    const d = c.porSoporte[s];
    html += `<tr><td>${escapar(s)}</td><td>${d.n}</td><td>${fmtMoneda(d.monto)}</td></tr>`;
  });
  html += `</tbody><tfoot><tr><th>Total cobrado</th><th>${c.vehiculos}</th><th>${fmtMoneda(c.total + c.totalFacturado)}</th></tr></tfoot></table>`;

  html += '<table class="tabla" style="margin-top:12px;"><thead><tr><th>Medio de pago</th><th>Vehículos</th><th>Monto</th></tr></thead><tbody>';
  Object.keys(c.porMedio).forEach((m) => {
    const d = c.porMedio[m];
    html += `<tr><td>${escapar(m)}</td><td>${d.n}</td><td>${fmtMoneda(d.monto)}</td></tr>`;
  });
  html += "</tbody></table>";

  html += '<p class="texto-ayuda" style="margin-top:8px;">El total de caja (' + fmtMoneda(c.total) +
    ") es lo que ENTRÓ a portería. Lo facturado al cliente (" + fmtMoneda(c.totalFacturado) +
    ") se cuenta aparte porque no pasó por la caja, y sumarlos daría una cifra que no cuadra con el arqueo.</p>";

  cont.innerHTML = html;
}


/* =========================================================
   CAPACIDAD Y NIVEL DE SERVICIO

   Cierra los tres campos que el administrador ya configuraba y
   que ningún panel usaba: `posicionesTotales`, `capacidadDiaria`
   y `pesosNivelServicio`.

   ── OCUPACIÓN PICO ──
   El momento del periodo en que hubo más vehículos adentro a la
   vez, contra las posiciones instaladas. Se calcula barriendo
   entradas y salidas en orden, no contando registros: dos
   vehículos que entraron y salieron el mismo día no ocuparon dos
   posiciones si no coincidieron.

   ── USO DE CAPACIDAD ──
   Vehículos atendidos por día contra `capacidadDiaria`. Es un
   promedio de los días del periodo, no del total: un mes con 30
   días y 300 vehículos son 10 diarios, no 300.

   ── ÍNDICE DE NIVEL DE SERVICIO ──
   El compuesto que los pesos ya anticipaban. Dos mitades:

       cita          % de los vehículos con cita que llegaron
                     en hora (± 10 min)
       programación  % de los vehículos que venían programados

   Con los pesos por defecto (50/50) las dos pesan igual. Si una
   de las dos mitades no se puede calcular —nadie traía cita en
   el periodo— el índice queda en "—" en vez de inventar el
   promedio con la mitad que sí hay: un índice a medias se leería
   como el índice completo.
   ========================================================= */

function maxSimultaneos(recs) {

  const eventos = [];

  recs.forEach((r) => {
    if (!r.horaEntrada) return;
    const entrada = new Date(r.horaEntrada);
    if (isNaN(entrada)) return;
    eventos.push({ t: entrada, d: 1 });
    if (r.horaSalida) {
      const salida = new Date(r.horaSalida);
      if (!isNaN(salida)) eventos.push({ t: salida, d: -1 });
    }
  });

  // En un empate exacto la salida va primero: el vehículo que se va
  // a las 10:00 dejó la posición libre para el que llega a las
  // 10:00, y contarlos juntos inflaría el pico en uno.
  eventos.sort((a, b) => (a.t - b.t) || (a.d - b.d));

  let actual = 0, pico = 0;
  eventos.forEach((e) => {
    actual += e.d;
    if (actual > pico) pico = actual;
  });

  return pico;
}

function renderNivelServicio(recs, dias, config) {

  const posiciones = (config && config.posicionesTotales) || 0;
  const capacidad = (config && config.capacidadDiaria) || 0;

  const pico = maxSimultaneos(recs);
  setTexto("es-ocupacion-pico", posiciones > 0
    ? Math.round((pico / posiciones) * 100) + "%"
    : pico + " veh.");

  const porDia = dias.length ? recs.length / dias.length : recs.length;
  setTexto("es-capacidad-pct", capacidad > 0 ? Math.round((porDia / capacidad) * 100) + "%" : "—");

  const on = resumenOnTime(recs);
  const enHora = on.tramos.filter((t) => t.clave === "en-hora")[0];
  const pctCita = on.total ? (enHora.n / on.total) * 100 : null;

  const programados = recs.filter((r) => r.programado && r.horaProgramacion).length;
  const pctProg = recs.length ? (programados / recs.length) * 100 : null;

  const pesos = (config && config.pesosNivelServicio) || { cita: 50, programacion: 50 };
  const completo = pctCita !== null && pctProg !== null;
  const indice = completo
    ? Math.round((pctCita * pesos.cita + pctProg * pesos.programacion) / 100)
    : null;

  setTexto("es-nivel-servicio", indice === null ? "—" : indice + "%");

  const cont = document.getElementById("es-nivel-detalle");
  if (!cont) return;

  const partes = [];
  partes.push("Ocupación pico: <strong>" + pico + " vehículo(s)</strong> a la vez" +
    (posiciones > 0 ? " sobre " + posiciones + " posiciones instaladas" : " (sin posiciones configuradas)") + ".");
  partes.push("Uso de capacidad: <strong>" + (Math.round(porDia * 10) / 10) + " vehículo(s)/día</strong>" +
    (capacidad > 0 ? " sobre una capacidad de " + capacidad : " (sin capacidad diaria configurada)") + ".");

  if (completo) {
    partes.push("Índice de nivel de servicio: cumplimiento de cita <strong>" + Math.round(pctCita) +
      "%</strong> (peso " + pesos.cita + ") y programación <strong>" + Math.round(pctProg) +
      "%</strong> (peso " + pesos.programacion + ").");
  } else {
    partes.push("El índice no se puede calcular en este periodo: " +
      (pctCita === null ? "ningún vehículo traía cita" : "no hay vehículos para medir programación") + ".");
  }

  cont.innerHTML = '<p class="texto-ayuda">' + partes.join(" ") + "</p>";
}


function renderOnTime(recs) {

  const cont = document.getElementById("ontime-tabla");
  if (!cont) return;

  const r = resumenOnTime(recs);

  if (!r.total) {
    cont.innerHTML = '<div class="texto-ayuda">Ningún vehículo del periodo traía hora programada, ' +
      "así que no hay cumplimiento que medir" +
      (r.sinCita ? " (" + r.sinCita + " vehículo(s) sin cita)" : "") + ".</div>";
    destruirSiExiste("chart-ontime");
    return;
  }

  let html = '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Tramo</th><th>Vehículos</th><th>%</th></tr></thead><tbody>';
  r.tramos.forEach((t) => {
    html += `<tr><td><span class="ontime-punto ontime-${t.color}"></span>${t.etiqueta}</td>` +
            `<td>${t.n}</td><td>${t.pct}%</td></tr>`;
  });
  html += `</tbody><tfoot><tr><th>Con cita</th><th>${r.total}</th><th>100%</th></tr></tfoot></table></div>`;
  html += '<p class="texto-ayuda" style="margin-top:8px;">Los porcentajes son sobre los ' + r.total +
    " vehículo(s) que traían cita. Otros " + r.sinCita + " del periodo entraron sin hora programada " +
    "y quedan fuera del indicador.</p>";
  cont.innerHTML = html;

  renderChart("chart-ontime", {
    type: "bar",
    data: {
      labels: r.tramos.map((t) => t.etiqueta),
      datasets: [{
        label: "Vehículos",
        data: r.tramos.map((t) => t.n),
        backgroundColor: r.tramos.map((t) => ONTIME_HEX[t.color]),
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: "y",
      layout: { padding: { right: 52 } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ctx.raw + " vehículo(s) · " + r.tramos[ctx.dataIndex].pct + "%" } },
        datalabels: {
          display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0,
          anchor: "end", align: "right", offset: 2,
          color: "#3A3A38", font: { size: 10, weight: "600" },
          formatter: (v, ctx) => v + " (" + r.tramos[ctx.dataIndex].pct + "%)"
        }
      },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}



/* =========================================================
   ACOMPAÑANTES DEL ON TIME

   Tres cajas del mismo tamaño debajo del cumplimiento de cita:
   los cinco que más se adelantaron, los cinco que más se
   retrasaron y el listado completo del periodo para revisar el
   dato crudo.

   Las tres reciben `recs`, que es la misma lista ya recortada
   por periodo y por canal que usa el resto del panel: se mueven
   con los filtros de fecha sin necesidad de nada más.
   ========================================================= */

/* `sentido` es -1 (llegó antes de la cita) o +1 (llegó después).
   Se ordena por magnitud del desfase, no por hora: lo que se
   busca aquí es el peor caso, y ese va primero.

   El desfase de 0 min no cae en ninguna de las dos: Math.sign(0)
   es 0 y no coincide con ningún sentido. Llegar clavado a la hora
   no es ni adelanto ni retraso. */
function renderTopDesfase(id, recs, sentido) {
  const cont = document.getElementById(id);
  if (!cont) return;

  const filas = recs
    .map((r) => ({ rec: r, ot: clasificarOnTime(r) }))
    .filter((f) => f.ot && Math.sign(f.ot.minutos) === sentido)
    .sort((a, b) => Math.abs(b.ot.minutos) - Math.abs(a.ot.minutos))
    .slice(0, 5);

  if (!filas.length) {
    cont.innerHTML = '<div class="texto-ayuda">Ningún vehículo con cita del periodo llegó ' +
      (sentido < 0 ? "antes" : "después") + " de su hora programada.</div>";
    return;
  }

  const columna = sentido < 0 ? "Adelanto" : "Retraso";
  let html = '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Placa</th><th>Cita</th>' +
    "<th>Llegada</th><th>" + columna + "</th></tr></thead><tbody>";
  filas.forEach((f) => {
    html += `<tr><td>${escapar(f.rec.placa)}</td>` +
            `<td>${fmtFechaHoraCorta(f.rec.horaProgramacion)}</td>` +
            `<td>${fmtFechaHoraCorta(f.rec.horaEntrada)}</td>` +
            `<td><span class="ontime-punto ontime-${f.ot.color}"></span>` +
            `${formatearMinutos(Math.abs(f.ot.minutos))}</td></tr>`;
  });
  html += "</tbody></table></div>";
  cont.innerHTML = html;
}

/* Los vehículos que OPERARON en el periodo, traigan cita o no: es
   la caja para revisar el dato crudo, y uno sin cita también hay
   que poder verlo. El más reciente arriba, que es por donde se
   empieza a mirar.

   Quien la llama le pasa la lista ya sin cancelados, por la misma
   razón que el resto del panel: un vehículo que no llegó no tiene
   desfase que mostrar. Ver el comentario en renderPanelEstadisticas().

   La caja no crece con los datos — el alto lo fija el CSS y la
   lista se desplaza dentro. Por eso el conteo va en el pie: con
   scroll no se puede saber cuántos son contando filas. */
function renderListadoVehiculos(id, recs) {
  const cont = document.getElementById(id);
  if (!cont) return;

  if (!recs.length) {
    cont.innerHTML = '<div class="texto-ayuda">No hay vehículos registrados en el periodo.</div>';
    return;
  }

  const filas = recs.slice().sort((a, b) =>
    String(b.horaEntrada || "").localeCompare(String(a.horaEntrada || ""))
  );

  let html = '<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Placa</th>' +
    "<th>Entrada</th><th>Desfase</th></tr></thead><tbody>";
  filas.forEach((r) => {
    const ot = clasificarOnTime(r);
    const desfase = ot
      ? '<span class="ontime-punto ontime-' + ot.color + '"></span>' + textoDesfase(ot.minutos)
      : '<span class="sin-cita">Sin cita</span>';
    html += `<tr><td>${escapar(r.placa)}</td>` +
            `<td>${fmtFechaHoraCorta(r.horaEntrada)}</td>` +
            `<td>${desfase}</td></tr>`;
  });
  html += "</tbody></table></div>";
  html += '<p class="texto-ayuda" style="margin-top:8px;">' + filas.length +
    " vehículo(s) registrados en el periodo.</p>";
  cont.innerHTML = html;
}

/* El signo es la mitad del dato: "45 min" no dice si llegó antes
   o después. Se usa el menos tipográfico (−), que a este tamaño
   no se confunde con un guion de separación. */
function textoDesfase(min) {
  if (min === 0) return "En hora";
  return (min < 0 ? "−" : "+") + formatearMinutos(Math.abs(min));
}

/* Día y hora sin año: las tres cajas viven dentro de un periodo ya
   elegido, así que el año es ruido, pero el día no se puede quitar
   — un periodo de una semana tiene siete "08:15" distintos. */
function fmtFechaHoraCorta(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleString("es-CO", {
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
}
