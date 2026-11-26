/* =========================================================
   INLOTRANS
   Apartado "Picking" del administrador

   Tiempos y productividad de las tareas del WMS (Iztech):
   picking, auditoría de picking y reposición, por operario, por tipo,
   por día y por hora, y lo que está en curso o esperando.

   Los datos los trae la función de Supabase `picking`
   (supabase/functions/picking): el token de Iztech vive allá. Los
   cálculos están en shared/services/picking.js.

   Se monta la primera vez que se abre la vista y no vuelve a
   consultar sola: Iztech es un sistema externo y cada consulta
   recorre miles de tareas. El botón "Actualizar" vuelve a pedir.
   ========================================================= */

import { supabase } from "../shared/core/supabase.js";
import { resumirPicking, resumirMovimientos, formatoMinutos } from "../shared/services/picking.js";
import { conXLSX } from "../shared/utils/xlsx.js";
import { montarInformeMensual } from "./informeMensual.js";

// La dirección (slug) de la función en Supabase. Se creó desde el
// editor del panel, que le puso este nombre, y el slug no se puede
// cambiar después: el código es el de supabase/functions/picking.
const FUNCION_PICKING = "dynamic-endpoint";

let montado = false;
let datos = null;          // la última respuesta de la función
let pedidoDesde = "";      // con qué `desde` se pidió
let grafica = null;
let resumen = null;
let movs = null;          // cajas y estibas (resumirMovimientos)

const $ = (id) => document.getElementById(id);

function escapar(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function hoy(offsetDias = 0) {
    const d = new Date(Date.now() + offsetDias * 86400000);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

const num = (n, dec = 0) => (n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("es-CO", { maximumFractionDigits: dec, minimumFractionDigits: dec }));

function filtros() {
    return {
        desde: $("pk-desde").value,
        hasta: $("pk-hasta").value,
        organizacion: $("pk-org").value,
        tipo: $("pk-tipo").value,
        bodega: $("pk-bodega").value
    };
}

/* Se abre la vista: la primera vez se monta y consulta. */
export function abrirPicking() {
    if (!montado) {
        montado = true;
        montarInformeMensual();
        $("pk-desde").value = hoy(-6);
        $("pk-hasta").value = hoy(0);
        $("pk-actualizar").addEventListener("click", () => consultar(true));
        $("pk-exportar").addEventListener("click", () => conXLSX(exportar));
        // Desde más atrás de lo ya traído → hay que volver a pedir;
        // lo demás se recalcula con lo que ya está.
        $("pk-desde").addEventListener("change", () => (pedidoDesde && $("pk-desde").value < pedidoDesde ? consultar(false) : pintar()));
        ["pk-hasta", "pk-org", "pk-tipo", "pk-bodega"].forEach((id) => $(id).addEventListener("change", pintar));
        consultar(false);
    }
}

async function consultar(forzar) {

    const desde = $("pk-desde").value || hoy(-6);
    if (!forzar && datos && pedidoDesde && desde >= pedidoDesde) return pintar();

    $("pk-estado").innerHTML = '<i class="ti ti-loader-2 pk-gira"></i> Consultando Iztech… (puede tardar unos segundos)';
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
            escapar(e.message || "No se pudo consultar el picking") +
            "</span> — revisa que la función <code>picking</code> esté desplegada en Supabase (supabase/LEEME.md).";
    } finally {
        $("pk-actualizar").disabled = false;
    }
}

function llenarSelect(sel, valores, etiquetaTodos) {
    const actual = sel.value;
    sel.innerHTML = '<option value="">' + etiquetaTodos + "</option>" +
        valores.map((v) => '<option value="' + escapar(v) + '"' + (v === actual ? " selected" : "") + ">" + escapar(v) + "</option>").join("");
}

function pintar() {

    if (!datos) return;

    const mov = datos.movimientos || null;
    resumen = resumirPicking(datos.filas, filtros(), new Date(), mov && mov.pedidos);
    movs = resumirMovimientos(mov, filtros());
    const r = resumen;
    llenarSelect($("pk-bodega"), movs.bodegas, "Todas las bodegas");
    pintarCajas(movs, !!mov);

    llenarSelect($("pk-org"), r.opciones.organizaciones, "Todas las organizaciones");
    llenarSelect($("pk-tipo"), r.opciones.tipos, "Todos los tipos");

    const cuando = new Date(datos.consultadoEn);
    $("pk-estado").innerHTML = "Consultado a las " + cuando.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) +
        " · " + num(datos.filas.length) + " tareas desde el " + escapar(datos.desde) +
        (datos.truncado ? ' · <span class="pk-error">se llegó al máximo de páginas: el rango puede estar incompleto</span>' : "") +
        (r.atipicas ? " · " + r.atipicas + " tarea(s) de más de 12 h fuera de los promedios" : "");

    const t = r.total;
    $("pk-s-tareas").textContent = num(t.completas);
    $("pk-s-lineas").textContent = num(t.lineas);
    $("pk-s-usuarios").textContent = num(r.usuarios.length);
    $("pk-s-prom").textContent = formatoMinutos(t.promedioMin);
    $("pk-s-lph").textContent = num(t.lineasPorHora, 1);
    $("pk-s-abiertas").textContent = r.enCurso + " / " + r.enEspera;

    const tipos = r.opciones.tipos;
    $("pk-usuarios-head").innerHTML = "<tr><th>#</th><th>Operario</th><th>Tareas</th>" +
        tipos.map((x) => "<th>" + escapar(x) + "</th>").join("") +
        "<th>Líneas</th><th>Cajas (picking)</th><th>Estibas (picking)</th><th>Cajas auditadas</th>" +
        "<th>Tiempo trabajado</th><th>Prom. / tarea</th><th>Líneas / hora</th><th>Cajas / hora</th><th>Tareas / hora</th></tr>";
    $("pk-usuarios-body").innerHTML = r.usuarios.map((u, i) =>
        "<tr><td>" + (i + 1) + "</td><td><strong>" + escapar(u.clave) + "</strong></td><td>" + num(u.completas) + "</td>" +
        tipos.map((x) => "<td>" + num(u.porTipo[x] || 0) + "</td>").join("") +
        "<td>" + num(u.lineas) + "</td><td>" + num(u.cajas) + "</td><td>" + num(u.estibas, 1) + "</td><td>" + num(u.cajasAuditadas) +
        "</td><td>" + formatoMinutos(u.minutos) + "</td><td>" + formatoMinutos(u.promedioMin) +
        "</td><td>" + num(u.lineasPorHora, 1) + "</td><td>" + num(u.cajasPorHora, 1) + "</td><td>" + num(u.tareasPorHora, 1) + "</td></tr>"
    ).join("") || filaVacia(10 + tipos.length, "Sin tareas en el rango");

    $("pk-tipos-body").innerHTML = r.tipos.map(filaGrupo).join("") || filaVacia(6);
    $("pk-org-body").innerHTML = r.organizaciones.map(filaGrupo).join("") || filaVacia(6);

    $("pk-horas-body").innerHTML = r.horas.filter((h) => h.tareas).map((h) =>
        "<tr><td>" + String(h.hora).padStart(2, "0") + ":00</td><td>" + num(h.tareas) + "</td><td>" + num(h.lineas) + "</td></tr>"
    ).join("") || filaVacia(3);

    $("pk-abiertas-body").innerHTML = r.abiertas.slice(0, 200).map((a) =>
        "<tr><td>" + escapar(a.nombre) + (a.descripcion ? '<div class="form-hint">' + escapar(a.descripcion) + "</div>" : "") +
        "</td><td>" + escapar(a.tipo) + "</td><td>" + etiquetaEstado(a.estado) + "</td><td>" + escapar(a.usuario || "—") +
        "</td><td>" + escapar(a.organizacion) + "</td><td>" + num(a.lineas) + "</td><td>" + formatoMinutos(a.esperaMin) + "</td></tr>"
    ).join("") || filaVacia(7, "No hay tareas en curso ni en espera");

    pintarGrafica(r.dias);
}

/* Cajas y estibas: tarjetas, por día y por bodega/documento. */
function pintarCajas(m, hay) {
    const s = m.total.salida, e = m.total.entrada;
    $("pk-c-cajas-sal").textContent = hay ? num(s.cajas) : "—";
    $("pk-c-estibas-sal").textContent = hay ? num(s.estibas) : "—";
    $("pk-c-cajas-ent").textContent = hay ? num(e.cajas) : "—";
    $("pk-c-estibas-ent").textContent = hay ? num(e.estibas) : "—";

    $("pk-cajas-dia-body").innerHTML = m.dias.map((d) =>
        "<tr><td>" + escapar(d.dia) + "</td><td>" + num(d.salida.cajas) + "</td><td>" + num(d.salida.estibas) +
        "</td><td>" + num(d.entrada.cajas) + "</td><td>" + num(d.entrada.estibas) + "</td></tr>"
    ).join("") || filaVacia(5, hay ? "Sin movimientos en el rango" : "Vuelve a desplegar la función para ver cajas y estibas");

    $("pk-cajas-doc-body").innerHTML = m.documentos.map((d) =>
        "<tr" + (d.ajuste ? ' class="pk-ajuste"' : "") + "><td><strong>" + escapar(d.bodega) + "</strong></td><td>" +
        (d.sentido === "salida" ? "Despachado" : "Recibido") + "</td><td>" + escapar(d.documento) +
        (d.ajuste ? ' <span class="form-hint">(no suma en totales)</span>' : "") +
        "</td><td>" + num(d.cajas) + "</td><td>" + num(d.estibas) + "</td><td>" + otras(d.otras) + "</td></tr>"
    ).join("") || filaVacia(6);
}

function otras(o) {
    const partes = Object.entries(o || {}).filter(([, c]) => c).map(([u, c]) => num(c) + " " + escapar(u));
    return partes.join(" · ") || "—";
}

function filaGrupo(g) {
    return "<tr><td><strong>" + escapar(g.clave) + "</strong></td><td>" + num(g.completas) + "</td><td>" + num(g.lineas) +
        "</td><td>" + formatoMinutos(g.minutos) + "</td><td>" + formatoMinutos(g.promedioMin) + "</td><td>" + num(g.lineasPorHora, 1) + "</td></tr>";
}

function filaVacia(columnas, texto = "Sin datos") {
    return '<tr><td colspan="' + columnas + '" style="text-align:center;color:var(--text-3);">' + texto + "</td></tr>";
}

function etiquetaEstado(e) {
    const txt = { Running: "En curso", Waiting: "En espera", Pending: "Pendiente" }[e] || e;
    const clase = e === "Running" ? "pk-en-curso" : "badge-amber";
    return '<span class="badge ' + clase + '">' + escapar(txt) + "</span>";
}

function pintarGrafica(dias) {
    const lienzo = $("pk-grafica");
    if (!lienzo || !window.Chart) return;
    const etiquetas = dias.map((d) => d.clave.slice(5));
    const config = {
        type: "bar",
        data: {
            labels: etiquetas,
            datasets: [
                { label: "Líneas", data: dias.map((d) => d.lineas), backgroundColor: "#2f6fde", yAxisID: "y" },
                { label: "Tareas", data: dias.map((d) => d.completas), backgroundColor: "#22a06b", yAxisID: "y1" }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { datalabels: { display: false }, legend: { position: "bottom" } },
            scales: {
                y: { beginAtZero: true, title: { display: true, text: "Líneas" } },
                y1: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Tareas" } }
            }
        }
    };
    // Se reutiliza: destruirla y crearla en cada filtro la dejaba con
    // ancho 0 (la nueva medía el lienzo antes de que se restaurara).
    if (grafica) {
        grafica.data = config.data;
        grafica.update();
    } else {
        grafica = new window.Chart(lienzo, config);
    }
}

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
