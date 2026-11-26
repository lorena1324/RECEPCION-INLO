/* =========================================================
   INLOTRANS
   Apartado "Picking" del administrador

   Tiempos y productividad de las tareas del WMS (Iztech) y las cajas
   y estibas despachadas y recibidas. Va en pestañas para que se lea
   de un vistazo:

     Resumen          los números grandes, la gráfica y los 5 primeros
     Operarios        la tabla completa (ordenable, con buscador)
     Cajas y estibas  por bodega y por día
     Pendientes       lo que está en curso o esperando
     Informe mensual  ver admin/informeMensual.js

   Los datos los trae la función de Supabase `picking`
   (supabase/functions/picking): el token de Iztech vive allá. Los
   cálculos están en shared/services/picking.js.

   Se monta la primera vez que se abre la vista y no vuelve a
   consultar sola: Iztech es un sistema externo y cada consulta
   recorre miles de tareas. "Actualizar" vuelve a pedir.
   ========================================================= */

import { supabase } from "../shared/core/supabase.js";
import { resumirPicking, resumirMovimientos, formatoMinutos } from "../shared/services/picking.js";
import { conXLSX } from "../shared/utils/xlsx.js";
import { montarInformeMensual } from "./informeMensual.js";

// La dirección (slug) de la función en Supabase. Se creó desde el
// editor del panel, que le puso este nombre, y el slug no se puede
// cambiar después: el código es el de supabase/functions/picking.
const FUNCION_PICKING = "dynamic-endpoint";

// En "Pendientes" se esconden por defecto las que llevan más de esto:
// casi siempre son tareas olvidadas en el WMS, no trabajo de hoy.
const PENDIENTE_RECIENTE_MIN = 7 * 24 * 60;

let montado = false;
let datos = null;          // la última respuesta de la función
let pedidoDesde = "";      // con qué `desde` se pidió
let grafica = null;
let resumen = null;
let movs = null;           // cajas y estibas (resumirMovimientos)
let orden = { col: "cajas", dir: -1 };

const $ = (id) => document.getElementById(id);

function escapar(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fecha(offsetDias = 0) {
    const d = new Date(Date.now() + offsetDias * 86400000);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

const num = (n, dec = 0) => (n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("es-CO", { maximumFractionDigits: dec, minimumFractionDigits: dec }));

/* "35 h 06 min" se lee mejor como horas con un decimal en una tabla. */
const horas = (min) => (min == null || !Number.isFinite(min) || min <= 0 ? "—" : num(min / 60, 1) + " h");

function filtros() {
    return {
        desde: $("pk-desde").value,
        hasta: $("pk-hasta").value,
        organizacion: $("pk-org").value,
        tipo: $("pk-tipo").value,
        bodega: $("pk-bodega").value
    };
}

/* ── PERIODO ─────────────────────────────────────────────── */

function rangoDe(periodo) {
    if (periodo === "hoy") return [fecha(0), fecha(0)];
    if (periodo === "ayer") return [fecha(-1), fecha(-1)];
    if (periodo === "mes") return [fecha(0).slice(0, 8) + "01", fecha(0)];
    return [fecha(-6), fecha(0)];
}

function elegirPeriodo(periodo) {
    document.querySelectorAll("[data-pk-periodo]").forEach((b) => b.classList.toggle("activo", b.getAttribute("data-pk-periodo") === periodo));
    $("pk-fechas").hidden = periodo !== "otro";
    if (periodo === "otro") return;
    const [d, h] = rangoDe(periodo);
    $("pk-desde").value = d;
    $("pk-hasta").value = h;
    cambioDeFechas();
}

// Más atrás de lo ya traído → hay que volver a pedir; si no, se recalcula.
function cambioDeFechas() {
    if (!pedidoDesde || $("pk-desde").value < pedidoDesde) consultar(false);
    else pintar();
}

/* ── PESTAÑAS ────────────────────────────────────────────── */

function irA(tab) {
    document.querySelectorAll("[data-pk-tab]").forEach((b) => b.classList.toggle("activo", b.getAttribute("data-pk-tab") === tab));
    document.querySelectorAll("[data-pk-panel]").forEach((p) => p.classList.toggle("activo", p.getAttribute("data-pk-panel") === tab));
    // La gráfica se dibujó con la pestaña oculta: hay que avisarle el tamaño.
    if (tab === "resumen" && grafica) grafica.resize();
}

/* Se abre la vista: la primera vez se monta y consulta. */
export function abrirPicking() {
    if (montado) return;
    montado = true;
    montarInformeMensual();

    const [d, h] = rangoDe("7");
    $("pk-desde").value = d;
    $("pk-hasta").value = h;

    document.querySelectorAll("[data-pk-periodo]").forEach((b) =>
        b.addEventListener("click", () => elegirPeriodo(b.getAttribute("data-pk-periodo"))));
    document.querySelectorAll("[data-pk-tab]").forEach((b) =>
        b.addEventListener("click", () => irA(b.getAttribute("data-pk-tab"))));
    document.querySelectorAll("[data-pk-ir]").forEach((b) =>
        b.addEventListener("click", () => irA(b.getAttribute("data-pk-ir"))));

    $("pk-actualizar").addEventListener("click", () => consultar(true));
    $("pk-exportar").addEventListener("click", () => conXLSX(exportar));
    $("pk-desde").addEventListener("change", cambioDeFechas);
    ["pk-hasta", "pk-org", "pk-tipo", "pk-bodega", "pk-viejas", "pk-mas-columnas"].forEach((id) => $(id).addEventListener("change", pintar));
    $("pk-buscar").addEventListener("input", pintarOperarios);

    // Ordenar la tabla de operarios al hacer clic en el encabezado.
    $("pk-usuarios-head").addEventListener("click", (e) => {
        const th = e.target.closest("[data-orden]");
        if (!th) return;
        const col = th.getAttribute("data-orden");
        orden = { col, dir: orden.col === col ? -orden.dir : (col === "clave" ? 1 : -1) };
        pintarOperarios();
    });

    consultar(false);
}

async function consultar(forzar) {

    const desde = $("pk-desde").value || fecha(-6);
    if (!forzar && datos && pedidoDesde && desde >= pedidoDesde) return pintar();

    $("pk-estado").innerHTML = '<i class="ti ti-loader-2 pk-gira"></i> Consultando el WMS… tarda unos 20 segundos.';
    $("pk-actualizar").disabled = true;

    try {
        const { data, error } = await supabase.functions.invoke(FUNCION_PICKING, { body: { desde } });
        if (error) {
            let detalle = error.message;
            try { detalle = (await error.context.json()).error || detalle; } catch { /* sin cuerpo */ }
            throw new Error(detalle);
        }
        if (data && data.error) throw new Error(data.error);
        datos = data;
        pedidoDesde = desde;
        pintar();
    } catch (e) {
        console.error("[picking]", e);
        $("pk-estado").innerHTML = '<span class="pk-error"><i class="ti ti-alert-triangle"></i> ' +
            escapar(e.message || "No se pudo consultar el WMS") +
            "</span> — si sigue pasando, revisa la función en Supabase (supabase/LEEME.md).";
    } finally {
        $("pk-actualizar").disabled = false;
    }
}

function llenarSelect(sel, valores, etiquetaTodos) {
    const actual = sel.value;
    sel.innerHTML = '<option value="">' + etiquetaTodos + "</option>" +
        valores.map((v) => '<option value="' + escapar(v) + '"' + (v === actual ? " selected" : "") + ">" + escapar(v) + "</option>").join("");
}

function filaVacia(columnas, texto = "Sin datos en este periodo") {
    return '<tr><td colspan="' + columnas + '" class="pk-vacia">' + texto + "</td></tr>";
}

/* ── PINTAR ──────────────────────────────────────────────── */

function pintar() {

    if (!datos) return;

    const mov = datos.movimientos || null;
    resumen = resumirPicking(datos.filas, filtros(), new Date(), mov && mov.pedidos);
    movs = resumirMovimientos(mov, filtros());
    const r = resumen;

    llenarSelect($("pk-org"), r.opciones.organizaciones, "Todas");
    llenarSelect($("pk-tipo"), r.opciones.tipos, "Todas");
    llenarSelect($("pk-bodega"), movs.bodegas, "Todas");

    const f = filtros();
    const cuando = new Date(datos.consultadoEn);
    const periodo = f.desde === f.hasta ? "el " + fechaCorta(f.desde) : "del " + fechaCorta(f.desde) + " al " + fechaCorta(f.hasta);
    $("pk-estado").innerHTML = "Mostrando " + periodo + " · datos del WMS de las " +
        cuando.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) +
        (datos.truncado || (mov && mov.truncado) ? ' · <span class="pk-error">la consulta llegó al máximo: puede faltar información</span>' : "");

    pintarResumen(r, movs, !!mov);
    pintarOperarios();
    pintarCajas(movs, !!mov);
    pintarPendientes(r);

    $("pk-tipos-body").innerHTML = r.tipos.map(filaGrupo).join("") || filaVacia(6);
    $("pk-org-body").innerHTML = r.organizaciones.map(filaGrupo).join("") || filaVacia(6);
    $("pk-horas-body").innerHTML = r.horas.filter((h) => h.tareas).map((h) =>
        "<tr><td>" + String(h.hora).padStart(2, "0") + ":00</td><td>" + num(h.tareas) + "</td><td>" + num(h.lineas) + "</td></tr>"
    ).join("") || filaVacia(3);
}

function fechaCorta(iso) {
    if (!iso) return "—";
    const [a, m, d] = iso.split("-").map(Number);
    return new Date(a, m - 1, d).toLocaleDateString("es-CO", { day: "numeric", month: "short" });
}

function pintarResumen(r, m, hayMov) {
    const t = r.total;
    $("pk-s-tareas").textContent = num(t.completas);
    $("pk-s-lineas").textContent = num(t.lineas);
    $("pk-s-usuarios").textContent = num(r.usuarios.length);
    $("pk-s-prom").textContent = formatoMinutos(t.promedioMin);
    $("pk-s-lph").textContent = num(t.lineasPorHora, 1);

    const s = m.total.salida, e = m.total.entrada;
    $("pk-c-cajas-sal").textContent = hayMov ? num(s.cajas) : "—";
    $("pk-c-estibas-sal").textContent = hayMov ? num(s.estibas) : "—";
    $("pk-c-cajas-ent").textContent = hayMov ? num(e.cajas) : "—";
    $("pk-c-estibas-ent").textContent = hayMov ? num(e.estibas) : "—";

    // Los 5 primeros: por cajas si hay, si no por líneas.
    const porCajas = r.usuarios.some((u) => u.cajas > 0);
    const campo = porCajas ? "cajas" : "lineas";
    const top = [...r.usuarios].sort((a, b) => b[campo] - a[campo]).slice(0, 5);
    const max = top.length ? top[0][campo] || 1 : 1;
    $("pk-top").innerHTML = top.map((u, i) =>
        '<div class="pk-barra-fila"><span class="pk-pos">' + (i + 1) + '</span><span class="pk-nombre">' + escapar(u.clave) + "</span>" +
        '<span class="pk-barra-fondo"><span class="pk-barra-lleno" style="width:' + Math.max(3, (u[campo] / max) * 100) + '%"></span></span>' +
        '<span class="pk-barra-num">' + num(u[campo]) + " " + (porCajas ? "cajas" : "líneas") + "</span></div>"
    ).join("") || '<div class="pk-vacia">Nadie terminó tareas en este periodo.</div>';

    const recientes = r.abiertas.filter((a) => a.esperaMin == null || a.esperaMin <= PENDIENTE_RECIENTE_MIN);
    const enCurso = recientes.filter((a) => a.estado === "Running").length;
    const esperando = recientes.length - enCurso;
    $("pk-ahora").innerHTML = '<i class="ti ti-player-play"></i> <strong>Ahora mismo:</strong> ' +
        num(enCurso) + " tarea(s) en curso y " + num(esperando) + " esperando a que alguien las tome. " +
        '<button class="pk-enlace" data-pk-ir-pend>ver pendientes →</button>';
    $("pk-ahora").querySelector("[data-pk-ir-pend]").addEventListener("click", () => irA("pendientes"));
    $("pk-n-pendientes").textContent = recientes.length ? recientes.length : "";

    pintarGrafica(r.dias);
}

/* Columnas de la tabla de operarios. `extra`: solo con "Ver más columnas". */
function columnasOperarios(tipos) {
    return [
        { id: "clave", titulo: "Operario", valor: (u) => "<strong>" + escapar(u.clave) + "</strong>" },
        { id: "completas", titulo: "Tareas", valor: (u) => num(u.completas) },
        ...tipos.map((x) => ({ id: "tipo:" + x, titulo: x, extra: true, valor: (u) => num(u.porTipo[x] || 0) })),
        { id: "lineas", titulo: "Líneas", valor: (u) => num(u.lineas) },
        { id: "cajas", titulo: "Cajas", ayuda: "Cajas de los pedidos que alistó, repartidas por líneas", valor: (u) => num(u.cajas) },
        { id: "estibas", titulo: "Estibas", valor: (u) => num(u.estibas) },
        { id: "cajasAuditadas", titulo: "Cajas auditadas", extra: true, valor: (u) => num(u.cajasAuditadas) },
        { id: "minutos", titulo: "Horas trabajadas", ayuda: "Suma de lo que tardó cada tarea", valor: (u) => horas(u.minutos) },
        { id: "promedioMin", titulo: "Promedio por tarea", extra: true, valor: (u) => formatoMinutos(u.promedioMin) },
        { id: "lineasPorHora", titulo: "Líneas por hora", extra: true, valor: (u) => num(u.lineasPorHora, 1) },
        { id: "cajasPorHora", titulo: "Cajas por hora", ayuda: "Velocidad en picking", barra: true, valor: (u) => num(u.cajasPorHora, 0) }
    ];
}

function valorOrden(u, col) {
    if (col.startsWith("tipo:")) return u.porTipo[col.slice(5)] || 0;
    const v = u[col];
    return v == null ? -Infinity : v;
}

function pintarOperarios() {
    if (!resumen) return;
    const mas = $("pk-mas-columnas").checked;
    const cols = columnasOperarios(resumen.opciones.tipos).filter((c) => mas || !c.extra);
    const buscar = $("pk-buscar").value.trim().toLowerCase();

    $("pk-usuarios-head").innerHTML = "<tr><th>#</th>" + cols.map((c) =>
        '<th data-orden="' + escapar(c.id) + '" class="pk-ordenable' + (orden.col === c.id ? " ordenado" : "") + '"' +
        (c.ayuda ? ' title="' + escapar(c.ayuda) + '"' : "") + ">" + escapar(c.titulo) +
        (orden.col === c.id ? (orden.dir > 0 ? " ▲" : " ▼") : "") + "</th>").join("") + "</tr>";

    const lista = resumen.usuarios
        .filter((u) => !buscar || u.clave.toLowerCase().includes(buscar))
        .sort((a, b) => {
            const x = valorOrden(a, orden.col), y = valorOrden(b, orden.col);
            return (typeof x === "string" ? x.localeCompare(y) : x - y) * orden.dir;
        });

    // La barra se escala contra el 90 % más alto, para que un solo valor
    // extremo (alguien con una tarea cortísima) no aplaste a los demás.
    const vel = lista.map((u) => u.cajasPorHora || 0).filter((v) => v > 0).sort((a, b) => a - b);
    const maxVel = Math.max(1, vel.length ? vel[Math.floor((vel.length - 1) * 0.9)] : 1);

    $("pk-usuarios-body").innerHTML = lista.map((u, i) => "<tr><td class='pk-pos'>" + (i + 1) + "</td>" + cols.map((c) =>
        c.barra
            ? '<td><div class="pk-celda-barra"><span class="pk-barra-fondo"><span class="pk-barra-lleno" style="width:' +
              (Math.min(1, (u.cajasPorHora || 0) / maxVel) * 100) + '%"></span></span><span>' + c.valor(u) + "</span></div></td>"
            : "<td>" + c.valor(u) + "</td>").join("") + "</tr>"
    ).join("") || filaVacia(cols.length + 1, buscar ? "Ningún operario coincide con la búsqueda" : "Nadie terminó tareas en este periodo");
}

function pintarCajas(m, hay) {
    const bodegas = new Map();
    for (const d of m.documentos) {
        if (d.ajuste) continue;
        if (!bodegas.has(d.bodega)) bodegas.set(d.bodega, { cs: 0, es: 0, ce: 0, ee: 0 });
        const b = bodegas.get(d.bodega);
        if (d.sentido === "salida") { b.cs += d.cajas; b.es += d.estibas; } else { b.ce += d.cajas; b.ee += d.estibas; }
    }
    const sinMov = hay ? "Sin movimientos en este periodo" : "Vuelve a desplegar la función para ver cajas y estibas";

    $("pk-cajas-bodega-body").innerHTML = [...bodegas].sort().map(([b, x]) =>
        "<tr><td><strong>" + escapar(b) + "</strong></td><td>" + num(x.cs) + "</td><td>" + num(x.es) + "</td><td>" + num(x.ce) + "</td><td>" + num(x.ee) + "</td></tr>"
    ).join("") || filaVacia(5, sinMov);

    $("pk-cajas-dia-body").innerHTML = m.dias.map((d) =>
        "<tr><td>" + fechaCorta(d.dia) + "</td><td>" + num(d.salida.cajas) + "</td><td>" + num(d.salida.estibas) +
        "</td><td>" + num(d.entrada.cajas) + "</td><td>" + num(d.entrada.estibas) + "</td></tr>"
    ).join("") || filaVacia(5, sinMov);

    $("pk-cajas-doc-body").innerHTML = m.documentos.map((d) =>
        "<tr" + (d.ajuste ? ' class="pk-ajuste"' : "") + "><td><strong>" + escapar(d.bodega) + "</strong></td><td>" +
        (d.sentido === "salida" ? "Despachado" : "Recibido") + "</td><td>" + escapar(d.documento) +
        (d.ajuste ? " <em>(no se cuenta)</em>" : "") +
        "</td><td>" + num(d.cajas) + "</td><td>" + num(d.estibas) + "</td><td>" + otras(d.otras) + "</td></tr>"
    ).join("") || filaVacia(6, sinMov);
}

function otras(o) {
    const partes = Object.entries(o || {}).filter(([, c]) => c).map(([u, c]) => num(c) + " " + escapar(u));
    return partes.join(" · ") || "—";
}

function pintarPendientes(r) {
    const viejas = $("pk-viejas").checked;
    const lista = r.abiertas.filter((a) => viejas || a.esperaMin == null || a.esperaMin <= PENDIENTE_RECIENTE_MIN);
    const ocultas = r.abiertas.length - lista.length;
    $("pk-abiertas-body").innerHTML = lista.slice(0, 300).map((a) =>
        "<tr><td>" + escapar(a.nombre) + (a.descripcion ? '<div class="pk-sub">' + escapar(a.descripcion) + "</div>" : "") +
        "</td><td>" + escapar(a.tipo) + "</td><td>" + etiquetaEstado(a.estado) + "</td><td>" + escapar(a.usuario || "Sin asignar") +
        "</td><td>" + num(a.lineas) + "</td><td>" + formatoMinutos(a.esperaMin) + "</td></tr>"
    ).join("") || filaVacia(6, "No hay tareas pendientes" + (ocultas ? " de los últimos 7 días (" + ocultas + " más viejas ocultas)" : ""));
}

function filaGrupo(g) {
    return "<tr><td><strong>" + escapar(g.clave) + "</strong></td><td>" + num(g.completas) + "</td><td>" + num(g.lineas) +
        "</td><td>" + horas(g.minutos) + "</td><td>" + formatoMinutos(g.promedioMin) + "</td><td>" + num(g.lineasPorHora, 1) + "</td></tr>";
}

function etiquetaEstado(e) {
    const txt = { Running: "En curso", Waiting: "Esperando", Pending: "Pendiente" }[e] || e;
    const clase = e === "Running" ? "pk-en-curso" : "badge-amber";
    return '<span class="badge ' + clase + '">' + escapar(txt) + "</span>";
}

function pintarGrafica(dias) {
    const lienzo = $("pk-grafica");
    if (!lienzo || !window.Chart) return;
    const config = {
        type: "bar",
        data: {
            labels: dias.map((d) => fechaCorta(d.clave)),
            datasets: [{ label: "Líneas alistadas", data: dias.map((d) => d.lineas), backgroundColor: "#2f6fde", borderRadius: 4 }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { datalabels: { display: false }, legend: { display: false } },
            scales: { y: { beginAtZero: true, grid: { color: "rgba(0,0,0,.06)" } }, x: { grid: { display: false } } }
        }
    };
    // Se reutiliza: destruirla y crearla en cada filtro la dejaba con ancho 0.
    if (grafica) {
        grafica.data = config.data;
        grafica.update();
    } else {
        grafica = new window.Chart(lienzo, config);
    }
}

/* ── EXCEL ───────────────────────────────────────────────── */

function exportar() {
    if (!resumen) return;
    const X = window.XLSX;
    const libro = X.utils.book_new();
    const tipos = resumen.opciones.tipos;
    const h = (m) => (m == null ? "" : Math.round(m * 10) / 10);

    X.utils.book_append_sheet(libro, X.utils.json_to_sheet(resumen.usuarios.map((u) => {
        const fila = { Operario: u.clave, Tareas: u.completas };
        tipos.forEach((x) => { fila[x] = u.porTipo[x] || 0; });
        return Object.assign(fila, {
            Lineas: u.lineas, "Cajas picking": Math.round(u.cajas), "Estibas picking": h(u.estibas),
            "Cajas auditadas": Math.round(u.cajasAuditadas),
            "Minutos trabajados": h(u.minutos), "Min. prom. por tarea": h(u.promedioMin),
            "Lineas por hora": h(u.lineasPorHora), "Cajas por hora": h(u.cajasPorHora), "Tareas por hora": h(u.tareasPorHora)
        });
    })), "Por operario");

    if (movs) {
        X.utils.book_append_sheet(libro, X.utils.json_to_sheet(movs.dias.map((d) => ({
            Dia: d.dia, "Cajas despachadas": d.salida.cajas, "Estibas despachadas": d.salida.estibas,
            "Cajas recibidas": d.entrada.cajas, "Estibas recibidas": d.entrada.estibas
        }))), "Cajas por dia");
        X.utils.book_append_sheet(libro, X.utils.json_to_sheet(movs.documentos.map((d) => ({
            Bodega: d.bodega, Sentido: d.sentido === "salida" ? "Despachado" : "Recibido", Documento: d.documento,
            Cajas: d.cajas, Estibas: d.estibas, Otras: Object.entries(d.otras).map(([u, c]) => c + " " + u).join(", "),
            "Suma en totales": d.ajuste ? "No (ajuste)" : "Si"
        }))), "Cajas por bodega");
    }

    const grupo = (g, nombre) => ({ [nombre]: g.clave, Tareas: g.completas, Lineas: g.lineas,
        "Minutos": h(g.minutos), "Min. prom. por tarea": h(g.promedioMin), "Lineas por hora": h(g.lineasPorHora) });
    X.utils.book_append_sheet(libro, X.utils.json_to_sheet(resumen.tipos.map((g) => grupo(g, "Tipo"))), "Por tipo");
    X.utils.book_append_sheet(libro, X.utils.json_to_sheet(resumen.dias.map((g) => grupo(g, "Dia"))), "Por dia");
    X.utils.book_append_sheet(libro, X.utils.json_to_sheet(resumen.organizaciones.map((g) => grupo(g, "Organizacion"))), "Por organizacion");

    const f = filtros();
    const tareas = (datos.filas || []).map((x) => ({
        Id: x.ctsk_id, Tarea: x.ctsk_task_name, Descripcion: x.ctsk_task_description, Tipo: x.ctst_name,
        Estado: x.ctsk_task_state, Usuario: x.ctsk_task_user, Organizacion: x.ctsk_organization_id, Regla: x.crul_name,
        Lineas: x.ctsk_lines, Activada: x.ctsk_waiting_date, Iniciada: x.ctsk_running_date, Terminada: x.ctsk_complete_date,
        Tiempo: x.ctti_time_els_value
    }));
    X.utils.book_append_sheet(libro, X.utils.json_to_sheet(tareas), "Tareas");

    X.writeFile(libro, "picking_" + (f.desde || "") + "_a_" + (f.hasta || "") + ".xlsx");
}
