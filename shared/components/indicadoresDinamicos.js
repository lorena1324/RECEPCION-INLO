/* =========================================================
   INLOTRANS — Indicadores dinámicos (compartido)

   Lo que convierte las cifras planas de Estadísticas en
   indicadores que se pueden leer y explorar:

     tarjetaDinamica()    la cifra se anima al cambiar, dice cuánto
                          subió o bajó contra el periodo anterior y
                          trae una mini tendencia día a día. Al
                          tocarla se abre la tabla de vehículos que
                          forman esa cifra.
     conmutadorGrafica()  cada gráfica tiene "Gráfica | Tabla": los
                          mismos datos, en filas, para copiar,
                          ordenar o exportar.
     tablasInteractivas() toda tabla se ordena tocando su encabezado,
                          las cifras llevan una barra de fondo
                          proporcional y se exporta a Excel.
     abrirDetalle()       la ventana con el detalle de una cifra.

   No calcula nada: recibe los números ya hechos por
   shared/services/estadisticas.js, que sigue siendo la única
   fuente de las cifras. Los estilos se inyectan una vez y usan
   las variables del tema de la app (claro y oscuro).
   ========================================================= */

import { getDestino, getLocationDurations, canalDe } from "../services/eventos.js";
import { formatDuration } from "../utils/tiempos.js";


/* =========================================================
   ESTILOS
   ========================================================= */

const CSS = `
.ff { display:flex; flex-wrap:wrap; align-items:center; gap:10px 16px; width:100%; }
.ff-rango { display:flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid var(--border-md); border-radius:var(--radius-lg); background:var(--surface); }
.ff-icono { color:var(--blue-600); font-size:18px; }
.ff-campo { display:flex; flex-direction:column; font-size:10.5px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--text-3); }
.ff-campo input { border:0; background:transparent; color:var(--text-1); font:inherit; font-size:14px; font-weight:600; letter-spacing:0; text-transform:none; padding:0; outline:none; }
.ff-flecha { color:var(--text-3); }
.ff-atajos { display:flex; flex-wrap:wrap; gap:6px; }
.ff-atajo { border:1px solid var(--border-md); background:var(--surface); color:var(--text-2); border-radius:999px; padding:5px 12px; font-size:12.5px; cursor:pointer; transition:background .15s, color .15s, border-color .15s; }
.ff-atajo:hover { border-color:var(--blue-600); color:var(--blue-600); }
.ff-atajo.activo { background:var(--blue-600); border-color:var(--blue-600); color:#fff; }
.ff-resumen { font-size:12px; color:var(--text-3); margin-left:auto; }

.card-resumen.kpi-clic { cursor:pointer; position:relative; transition:transform .15s, box-shadow .15s; }
.card-resumen.kpi-clic:hover { transform:translateY(-2px); box-shadow:var(--shadow-md); }
.card-resumen.kpi-clic:focus-visible { outline:2px solid var(--blue-600); outline-offset:2px; }
.kpi-extra { display:flex; align-items:flex-end; justify-content:space-between; gap:8px; margin-top:8px; min-height:26px; }
.kpi-delta { display:inline-flex; align-items:center; gap:3px; font-size:11.5px; font-weight:700; padding:2px 7px; border-radius:999px; white-space:nowrap; animation:kpi-aparecer .4s ease both; }
.kpi-delta small { font-weight:500; opacity:.8; }
.kpi-delta.bien { color:var(--sem-ok, #3B6D11); background:var(--sem-ok-suave, #EAF3DE); }
.kpi-delta.mal { color:var(--sem-alta, #A32D2D); background:var(--sem-alta-suave, #FCEBEB); }
.kpi-delta.neutro { color:var(--text-2); background:var(--surface-3); }
.kpi-spark { width:96px; height:26px; flex-shrink:0; overflow:visible; }
.kpi-spark .linea { fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; stroke-dasharray:1; stroke-dashoffset:1; animation:kpi-trazo .9s ease forwards; }
.kpi-spark .area { fill-opacity:.16; animation:kpi-aparecer .9s ease both; }
.kpi-pista { position:absolute; top:8px; right:10px; font-size:14px; color:var(--text-3); opacity:0; transition:opacity .15s; }
.card-resumen.kpi-clic:hover .kpi-pista { opacity:1; }
@keyframes kpi-trazo { to { stroke-dashoffset:0; } }
@keyframes kpi-aparecer { from { opacity:0; transform:translateY(3px); } to { opacity:1; transform:none; } }

.stat-box.con-vistas { position:relative; }
.vista-toggle { position:absolute; top:12px; right:12px; display:inline-flex; border:1px solid var(--border-md); border-radius:8px; overflow:hidden; background:var(--surface); z-index:1; }
.vista-toggle button { border:0; background:transparent; color:var(--text-3); font-size:12px; padding:4px 9px; cursor:pointer; display:inline-flex; align-items:center; gap:4px; }
.vista-toggle button.activo { background:var(--blue-600); color:#fff; }
.chart-tabla { margin-top:6px; max-height:340px; overflow:auto; animation:kpi-aparecer .3s ease both; }

table.t-interactiva th.t-ordenable { cursor:pointer; user-select:none; white-space:nowrap; }
table.t-interactiva th.t-ordenable:hover { color:var(--blue-600); }
table.t-interactiva th .t-flecha { font-size:10px; margin-left:4px; opacity:.35; }
table.t-interactiva th[aria-sort] .t-flecha { opacity:1; color:var(--blue-600); }
table.t-interactiva td.t-barra { background-image:linear-gradient(90deg, var(--t-color, rgba(37,99,235,.14)) var(--t-pct, 0%), transparent var(--t-pct, 0%)); background-repeat:no-repeat; transition:background-size .4s; }
table.t-interactiva tbody tr { transition:background .12s; }
table.t-interactiva tbody tr:hover { background:var(--surface-2); }
.t-herramientas { display:flex; justify-content:flex-end; gap:6px; margin:4px 0; }
.t-herramientas button { border:1px solid var(--border-md); background:var(--surface); color:var(--text-2); border-radius:6px; font-size:12px; padding:3px 9px; cursor:pointer; display:inline-flex; align-items:center; gap:4px; }
.t-herramientas button:hover { color:var(--blue-600); border-color:var(--blue-600); }

.modal.kpi-modal { width:min(1000px, 96vw); max-width:none; max-height:90vh; display:flex; flex-direction:column; }
.kpi-modal .modal-header { margin-bottom:10px; }
.kpi-modal-sub { font-size:12.5px; color:var(--text-3); margin:-6px 0 10px; }
.kpi-modal-buscar { width:100%; padding:7px 10px; border:1px solid var(--border-md); border-radius:8px; background:var(--surface); color:var(--text-1); font:inherit; margin-bottom:8px; }
.kpi-modal-cuerpo { overflow:auto; flex:1; border:1px solid var(--border); border-radius:8px; }
.kpi-modal-cuerpo table { width:100%; }
.kpi-modal-cuerpo thead th { position:sticky; top:0; background:var(--surface-2); color:var(--text-2); z-index:1; }
.kpi-modal-cuerpo tbody tr, .kpi-modal-cuerpo td, .chart-tabla td { background-color:var(--surface); color:var(--text-1); }
.kpi-modal-cuerpo tbody tr:hover td { background-color:var(--surface-2); }
.kpi-modal .modal-footer { align-items:center; }
.kpi-modal-cuenta { margin-right:auto; font-size:12.5px; color:var(--text-3); }
`;

let estilosListos = false;

function asegurarEstilos() {
    if (estilosListos) return;
    const s = document.createElement("style");
    s.id = "indicadores-dinamicos";
    s.textContent = CSS;
    document.head.appendChild(s);
    estilosListos = true;
}

function escapar(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const reducirMovimiento = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;


/* =========================================================
   TARJETAS
   ========================================================= */

/*
    idValor    id del elemento con la cifra (es-total, es-promedio…)
    valor      número actual (null = sin dato)
    texto      el texto final exacto que ya escribió estadisticas.js
    formato    número → texto, para los cuadros de la animación
    anterior   la misma cifra en el periodo anterior (null = sin dato)
    serie      la cifra día a día dentro del rango (null en días sin dato)
    mejor      "subir" | "bajar" | null — si subir es bueno o malo
    detalle    () => ({ titulo, subtitulo, filas, columnas })
*/
export function tarjetaDinamica(idValor, o) {

    const el = document.getElementById(idValor);
    if (!el) return;
    asegurarEstilos();

    const tarjeta = el.closest(".card-resumen") || el.parentElement;

    // `soloDetalle`: una cifra de referencia (p. ej. el día pico) que
    // no se compara ni tiene tendencia, pero sí se puede abrir.
    if (!o.soloDetalle) {
        animarCifra(el, o.valor, o.texto, o.formato);

        let extra = tarjeta.querySelector(":scope > .kpi-extra");
        if (!extra) {
            extra = document.createElement("div");
            extra.className = "kpi-extra";
            tarjeta.appendChild(extra);
        }
        extra.innerHTML = htmlDelta(o) + htmlSparkline(o.serie, o.mejor);
    }

    if (o.detalle) {
        tarjeta.classList.add("kpi-clic");
        tarjeta.setAttribute("role", "button");
        tarjeta.setAttribute("tabindex", "0");
        tarjeta.setAttribute("title", "Ver el detalle");
        if (!tarjeta.querySelector(":scope > .kpi-pista")) {
            tarjeta.insertAdjacentHTML("beforeend", '<i class="ti ti-table kpi-pista" aria-hidden="true"></i>');
        }
        // Propiedad, no addEventListener: se reasigna en cada render
        // con los datos nuevos sin apilar manejadores.
        tarjeta.onclick = () => abrirDetalle(o.detalle());
        tarjeta.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrirDetalle(o.detalle()); } };
    }
}

function animarCifra(el, valor, texto, formato) {

    // La primera vez (o si antes no había dato) sube desde cero.
    const previo = el.dataset.valorNum;
    const anterior = previo === undefined || previo === "" ? 0 : Number(previo);
    el.dataset.valorNum = valor == null ? "" : String(valor);

    if (valor == null || !formato || !isFinite(anterior) || anterior === valor || reducirMovimiento()) {
        el.textContent = texto;
        return;
    }

    const inicio = performance.now();
    const duracion = 700;
    cancelAnimationFrame(Number(el.dataset.cuadro) || 0);

    const paso = (t) => {
        const f = Math.min(1, (t - inicio) / duracion);
        const suave = 1 - Math.pow(1 - f, 3);
        if (f < 1) {
            el.textContent = formato(anterior + (valor - anterior) * suave);
            el.dataset.cuadro = String(requestAnimationFrame(paso));
        } else {
            el.textContent = texto;    // el texto exacto, no el redondeo de la animación
        }
    };
    el.dataset.cuadro = String(requestAnimationFrame(paso));
}

function htmlDelta(o) {

    const { valor, anterior, mejor } = o;
    const etiqueta = o.formato ? o.formato(anterior) : String(anterior);

    if (valor == null || anterior == null) {
        return '<span class="kpi-delta neutro" title="Sin dato en el periodo anterior">— <small>vs anterior</small></span>';
    }
    if (anterior === 0) {
        return valor === 0
            ? '<span class="kpi-delta neutro" title="Periodo anterior: 0">= <small>vs anterior</small></span>'
            : '<span class="kpi-delta neutro" title="Periodo anterior: 0">nuevo <small>vs anterior</small></span>';
    }

    const pct = ((valor - anterior) / Math.abs(anterior)) * 100;
    const r = Math.round(pct);
    if (r === 0) {
        return '<span class="kpi-delta neutro" title="Periodo anterior: ' + escapar(etiqueta) + '">= <small>vs anterior</small></span>';
    }

    const sube = r > 0;
    const clase = !mejor ? "neutro" : (sube === (mejor === "subir") ? "bien" : "mal");
    return '<span class="kpi-delta ' + clase + '" title="Periodo anterior: ' + escapar(etiqueta) + '">' +
        (sube ? "▲" : "▼") + " " + Math.abs(r) + ' % <small>vs anterior</small></span>';
}

function htmlSparkline(serie, mejor) {

    const puntos = (serie || []).map((v, i) => ({ i, v }));
    const conDato = puntos.filter((p) => p.v != null && isFinite(p.v));
    if (conDato.length < 2) return "";

    const W = 96, H = 26, M = 2;
    const max = Math.max(...conDato.map((p) => p.v));
    const min = Math.min(0, ...conDato.map((p) => p.v));
    const n = Math.max(1, puntos.length - 1);
    const x = (i) => M + (i / n) * (W - 2 * M);
    const y = (v) => H - M - ((v - min) / (max - min || 1)) * (H - 2 * M);

    const linea = conDato.map((p, k) => (k ? "L" : "M") + x(p.i).toFixed(1) + " " + y(p.v).toFixed(1)).join(" ");
    const area = linea + " L" + x(conDato[conDato.length - 1].i).toFixed(1) + " " + (H - M) + " L" + x(conDato[0].i).toFixed(1) + " " + (H - M) + " Z";
    const color = mejor === "bajar" ? "var(--amber-600, #854F0B)" : "var(--blue-600, #2563eb)";
    const ultimo = conDato[conDato.length - 1];

    return '<svg class="kpi-spark" viewBox="0 0 ' + W + " " + H + '" aria-hidden="true">' +
        '<path class="area" d="' + area + '" fill="' + color + '"/>' +
        '<path class="linea" pathLength="1" d="' + linea + '" stroke="' + color + '"/>' +
        '<circle cx="' + x(ultimo.i).toFixed(1) + '" cy="' + y(ultimo.v).toFixed(1) + '" r="2.4" fill="' + color + '"/>' +
        "</svg>";
}


/* =========================================================
   DETALLE DE UNA CIFRA
   ========================================================= */

function fechaHora(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString("es-CO", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/* Las columnas de un vehículo cuando la cifra no pide otras. Patio
   y muelle salen del historial (getLocationDurations), igual que
   los promedios de las tarjetas. */
export const COLUMNAS_VEHICULO = [
    { titulo: "Placa", valor: (r) => r.placa || "" },
    { titulo: "Conductor / proveedor", valor: (r) => r.conductor || "" },
    { titulo: "Tipo", valor: (r) => r.tipo || "" },
    { titulo: "Canal", valor: (r) => canalDe(r) },
    { titulo: "Entrada", valor: (r) => r.horaEntrada || "", texto: (r) => fechaHora(r.horaEntrada) },
    { titulo: "Salida", valor: (r) => r.horaSalida || "", texto: (r) => fechaHora(r.horaSalida) },
    { titulo: "Ubicación", valor: (r) => getDestino(r) },
    { titulo: "Patio", valor: (r) => getLocationDurations(r).patio || 0, texto: (r) => formatDuration(getLocationDurations(r).patio || 0), numero: true },
    { titulo: "Muelle", valor: (r) => getLocationDurations(r).muelle || 0, texto: (r) => formatDuration(getLocationDurations(r).muelle || 0), numero: true }
];

let modalAbierto = null;

export function abrirDetalle(datos) {

    if (!datos) return;
    asegurarEstilos();
    cerrarDetalle();

    const columnas = datos.columnas || COLUMNAS_VEHICULO;
    const filas = datos.filas || [];

    const fondo = document.createElement("div");
    fondo.className = "modal-backdrop open";
    fondo.innerHTML =
        '<div class="modal kpi-modal" role="dialog" aria-modal="true" aria-label="' + escapar(datos.titulo) + '">' +
            '<div class="modal-header">' +
                '<div class="modal-title"><i class="ti ti-table"></i> ' + escapar(datos.titulo) + "</div>" +
                '<button type="button" class="modal-close" aria-label="Cerrar"><i class="ti ti-x"></i></button>' +
            "</div>" +
            (datos.subtitulo ? '<div class="kpi-modal-sub">' + escapar(datos.subtitulo) + "</div>" : "") +
            '<input type="search" class="kpi-modal-buscar" placeholder="Buscar placa, conductor, canal…">' +
            '<div class="kpi-modal-cuerpo"><table class="tabla"><thead><tr>' +
                columnas.map((c) => "<th>" + escapar(c.titulo) + "</th>").join("") +
            "</tr></thead><tbody>" +
                filas.map((r) => "<tr>" + columnas.map((c) => {
                    const v = c.valor(r);
                    return '<td data-orden="' + escapar(v) + '">' + escapar(c.texto ? c.texto(r) : v) + "</td>";
                }).join("") + "</tr>").join("") +
            "</tbody></table></div>" +
            '<div class="modal-footer">' +
                '<span class="kpi-modal-cuenta"></span>' +
                (window.XLSX ? '<button type="button" class="btn btn-sm kpi-exportar"><i class="ti ti-file-spreadsheet"></i> Exportar</button>' : "") +
                '<button type="button" class="btn btn-sm kpi-cerrar">Cerrar</button>' +
            "</div>" +
        "</div>";

    document.body.appendChild(fondo);
    modalAbierto = fondo;

    const tabla = fondo.querySelector("table");
    const cuenta = fondo.querySelector(".kpi-modal-cuenta");
    const contar = () => {
        const visibles = tabla.querySelectorAll("tbody tr:not([hidden])").length;
        cuenta.textContent = visibles === filas.length ? filas.length + " vehículo(s)" : visibles + " de " + filas.length + " vehículo(s)";
    };
    contar();
    hacerInteractiva(tabla, { barras: false, herramientas: false });

    fondo.querySelector(".kpi-modal-buscar").addEventListener("input", (e) => {
        const q = e.target.value.trim().toLowerCase();
        tabla.querySelectorAll("tbody tr").forEach((tr) => { tr.hidden = !!q && tr.textContent.toLowerCase().indexOf(q) === -1; });
        contar();
    });

    const exportar = fondo.querySelector(".kpi-exportar");
    if (exportar) exportar.addEventListener("click", () => exportarTabla(tabla, datos.titulo));

    fondo.querySelector(".modal-close").addEventListener("click", cerrarDetalle);
    fondo.querySelector(".kpi-cerrar").addEventListener("click", cerrarDetalle);
    fondo.addEventListener("click", (e) => { if (e.target === fondo) cerrarDetalle(); });
    document.addEventListener("keydown", alEscape);

    fondo.querySelector(".kpi-modal-buscar").focus();
}

function alEscape(e) {
    if (e.key === "Escape") cerrarDetalle();
}

function cerrarDetalle() {
    if (!modalAbierto) return;
    modalAbierto.remove();
    modalAbierto = null;
    document.removeEventListener("keydown", alEscape);
}


/* =========================================================
   GRÁFICA ↔ TABLA
   ========================================================= */

const MODOS_KEY = "inlotrans:estad-vistas";

function modosGuardados() {
    try { return JSON.parse(localStorage.getItem(MODOS_KEY) || "{}"); } catch (e) { return {}; }
}

function guardarModo(id, modo) {
    try {
        const m = modosGuardados();
        m[id] = modo;
        localStorage.setItem(MODOS_KEY, JSON.stringify(m));
    } catch (e) { /* solo se pierde recordar la vista */ }
}

/*
    canvas   el <canvas> de la gráfica
    config   la misma configuración que recibió Chart.js
    formato  número → texto para las celdas (p. ej. minutos)
*/
export function conmutadorGrafica(canvas, config, formato) {

    const caja = canvas && canvas.closest(".stat-box");
    if (!caja) return;
    asegurarEstilos();

    const id = canvas.id;
    caja.classList.add("con-vistas");

    let toggle = caja.querySelector(":scope > .vista-toggle");
    if (!toggle) {
        toggle = document.createElement("div");
        toggle.className = "vista-toggle";
        toggle.innerHTML =
            '<button type="button" data-modo="grafica" title="Ver como gráfica"><i class="ti ti-chart-bar"></i> Gráfica</button>' +
            '<button type="button" data-modo="tabla" title="Ver como tabla"><i class="ti ti-table"></i> Tabla</button>';
        caja.appendChild(toggle);
        toggle.addEventListener("click", (e) => {
            const b = e.target.closest("button[data-modo]");
            if (!b) return;
            guardarModo(id, b.dataset.modo);
            aplicarModo();
        });
    }

    let cont = caja.querySelector(":scope > .chart-tabla");
    if (!cont) {
        cont = document.createElement("div");
        cont.className = "chart-tabla";
        canvas.insertAdjacentElement("afterend", cont);
    }
    cont.innerHTML = tablaDesdeConfig(config, formato);
    hacerInteractiva(cont.querySelector("table"), { barras: !formato, herramientas: true, nombre: (caja.querySelector("h3") || {}).textContent });

    function aplicarModo() {
        const modo = modosGuardados()[id] || "grafica";
        canvas.style.display = modo === "tabla" ? "none" : "";
        cont.style.display = modo === "tabla" ? "" : "none";
        toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("activo", b.dataset.modo === modo));
    }
    aplicarModo();
}

function tablaDesdeConfig(config, formato) {

    const labels = (config.data && config.data.labels) || [];
    const series = (config.data && config.data.datasets) || [];
    if (!labels.length || !series.length) return '<div class="texto-ayuda">No hay datos para el periodo.</div>';

    const fmt = (v) => (v == null || v === "" ? "—" : formato ? formato(v) : v);
    const unaSerie = series.length === 1;
    const titulos = unaSerie ? [series[0].label || "Valor"] : series.map((s) => s.label || "");
    const sumable = !formato;
    const totales = series.map((s) => (s.data || []).reduce((a, v) => a + (Number(v) || 0), 0));

    let html = '<table class="tabla"><thead><tr><th></th>' +
        titulos.map((t) => "<th>" + escapar(t) + "</th>").join("") +
        (unaSerie && sumable ? "<th>%</th>" : "") +
        "</tr></thead><tbody>";

    labels.forEach((l, i) => {
        html += "<tr><td>" + escapar(l) + "</td>" +
            series.map((s) => {
                const v = s.data[i];
                return '<td data-orden="' + (v == null ? "" : v) + '">' + escapar(fmt(v)) + "</td>";
            }).join("") +
            (unaSerie && sumable
                ? '<td data-orden="' + (totales[0] ? (Number(series[0].data[i]) || 0) / totales[0] : 0) + '">' +
                  (totales[0] ? Math.round(((Number(series[0].data[i]) || 0) / totales[0]) * 100) : 0) + " %</td>"
                : "") +
            "</tr>";
    });

    html += "</tbody>";
    if (sumable) {
        html += "<tfoot><tr><th>Total</th>" + totales.map((t) => "<th>" + t + "</th>").join("") + (unaSerie ? "<th>100 %</th>" : "") + "</tr></tfoot>";
    }
    return html + "</table>";
}


/* =========================================================
   TABLAS: ORDENAR, BARRAS, EXPORTAR
   ========================================================= */

/* Toda tabla .tabla dentro de `raiz` que todavía no lo sea. Las
   tablas se rehacen en cada render (innerHTML), así que esto se
   llama al final de cada uno. */
export function tablasInteractivas(raiz) {
    if (!raiz) return;
    asegurarEstilos();
    raiz.querySelectorAll("table.tabla:not(.t-interactiva)").forEach((t) => {
        if (t.closest(".chart-tabla")) return; // ya la arma el conmutador
        const titulo = t.closest(".stat-box") && t.closest(".stat-box").querySelector("h3");
        hacerInteractiva(t, { barras: true, herramientas: true, nombre: titulo ? titulo.textContent : "tabla" });
    });
}

// "1h 20m", "1h 20min", "45 min", "12 %", "$1.200", "1.234" → número
function aNumero(texto) {
    const t = String(texto).trim();
    if (!t || t === "—") return null;
    const hm = t.match(/^(\d+)\s*h(?:\s*(\d+)\s*m(?:in)?)?$/i);
    if (hm) return Number(hm[1]) * 60 + Number(hm[2] || 0);
    const m = t.match(/^(\d+)\s*min$/i);
    if (m) return Number(m[1]);
    const limpio = t.replace(/[$%\s]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    return /^-?\d+(\.\d+)?$/.test(limpio) ? Number(limpio) : null;
}

function valorCelda(td) {
    if (!td) return "";
    if (td.dataset.orden !== undefined && td.dataset.orden !== "") {
        const n = Number(td.dataset.orden);
        return isFinite(n) ? n : td.dataset.orden;
    }
    const n = aNumero(td.textContent);
    return n === null ? td.textContent.trim().toLowerCase() : n;
}

function hacerInteractiva(tabla, { barras, herramientas, nombre }) {

    if (!tabla || tabla.classList.contains("t-interactiva")) return;
    tabla.classList.add("t-interactiva");

    const cuerpo = tabla.tBodies[0];
    const encabezados = tabla.tHead ? Array.from(tabla.tHead.rows[tabla.tHead.rows.length - 1].cells) : [];
    if (!cuerpo || !encabezados.length) return;

    // Con celdas combinadas el orden no tiene sentido: se deja quieta.
    const regular = !tabla.querySelector("tbody td[rowspan], tbody td[colspan], thead th[colspan]") &&
        Array.from(cuerpo.rows).every((tr) => tr.cells.length === encabezados.length);

    if (regular) {
        encabezados.forEach((th, col) => {
            if (!th.textContent.trim()) return;
            th.classList.add("t-ordenable");
            th.insertAdjacentHTML("beforeend", '<span class="t-flecha" aria-hidden="true">↕</span>');
            th.setAttribute("title", "Ordenar");
            th.addEventListener("click", () => {
                const asc = th.getAttribute("aria-sort") !== "ascending";
                encabezados.forEach((h) => { h.removeAttribute("aria-sort"); const f = h.querySelector(".t-flecha"); if (f) f.textContent = "↕"; });
                th.setAttribute("aria-sort", asc ? "ascending" : "descending");
                th.querySelector(".t-flecha").textContent = asc ? "▲" : "▼";

                const filas = Array.from(cuerpo.rows);
                filas.sort((a, b) => {
                    const va = valorCelda(a.cells[col]);
                    const vb = valorCelda(b.cells[col]);
                    const r = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "es");
                    return asc ? r : -r;
                });
                filas.forEach((tr) => cuerpo.appendChild(tr));
            });
        });

        // Barra de fondo en las columnas que son puras cifras: el
        // tamaño se lee sin comparar números de cabeza.
        if (barras) {
            encabezados.forEach((th, col) => {
                const celdas = Array.from(cuerpo.rows).map((tr) => tr.cells[col]).filter(Boolean);
                const nums = celdas.map((td) => (td.children.length ? null : aNumero(td.textContent)));
                const validos = nums.filter((n) => n !== null && n >= 0);
                if (col === 0 || validos.length < 2 || validos.length < celdas.length * 0.8) return;
                const max = Math.max(...validos);
                if (!max) return;
                celdas.forEach((td, i) => {
                    if (nums[i] === null) return;
                    td.classList.add("t-barra");
                    td.style.setProperty("--t-pct", Math.round((nums[i] / max) * 100) + "%");
                });
            });
        }
    }

    if (herramientas && window.XLSX) {
        const barra = document.createElement("div");
        barra.className = "t-herramientas";
        barra.innerHTML = '<button type="button"><i class="ti ti-file-spreadsheet"></i> Exportar</button>';
        barra.querySelector("button").addEventListener("click", () => exportarTabla(tabla, nombre));
        const marco = tabla.closest(".tabla-wrap, .table-wrap") || tabla;
        marco.insertAdjacentElement("beforebegin", barra);
    }
}

function exportarTabla(tabla, nombre) {
    if (!window.XLSX) return;
    const copia = tabla.cloneNode(true);
    copia.querySelectorAll(".t-flecha").forEach((f) => f.remove());
    copia.querySelectorAll("tr[hidden]").forEach((tr) => tr.remove());
    const libro = window.XLSX.utils.table_to_book(copia, { raw: true });
    const archivo = (String(nombre || "tabla").trim().replace(/[^\wáéíóúñÁÉÍÓÚÑ -]+/g, "").slice(0, 60) || "tabla") + ".xlsx";
    window.XLSX.writeFile(libro, archivo);
}
