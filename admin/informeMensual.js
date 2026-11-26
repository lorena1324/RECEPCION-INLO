/* =========================================================
   INLOTRANS
   Informe mensual (apartado Picking del administrador)

   Junta en un solo informe, para el mes que se elija:
     - el WMS (Iztech): tareas de picking, líneas, productividad por
       operario, cajas y estibas despachadas y recibidas por bodega;
     - la planilla "Control Muelles" de J3 (Excel a mano), si se
       adjunta: vehículos por muelle, por quien reporta, tiempos en
       muelle, cajas y estibas, y la comparación día a día contra lo
       que registró el WMS en J3.

   La planilla se lee aquí, en el navegador, y no se guarda en ningún
   lado. El informe se descarga en Excel o se imprime (o "Guardar como
   PDF" desde la ventana de impresión).
   ========================================================= */

import { supabase } from "../shared/core/supabase.js";
import { resumirPicking, resumirMovimientos, formatoMinutos } from "../shared/services/picking.js";
import { leerPlanilla, resumirPlanilla, conciliar } from "../shared/services/controlMuelles.js";
import { conXLSX, cargarXLSX } from "../shared/utils/xlsx.js";

const FUNCION_PICKING = "dynamic-endpoint";      // ver admin/picking.js
const BODEGA_PLANILLA = "J3";

const $ = (id) => document.getElementById(id);
let montado = false;
let informe = null;          // lo último generado (para Excel)

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function escapar(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const num = (n, dec = 0) => (n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("es-CO", { maximumFractionDigits: dec, minimumFractionDigits: dec }));
const p2 = (n) => String(n).padStart(2, "0");

function hoyISO() {
    const d = new Date();
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
}

/* "2026-10" → { desde: "2026-10-01", hasta: "2026-10-31" } (hasta hoy si es el mes en curso). */
export function rangoDelMes(mes) {
    const [a, m] = mes.split("-").map(Number);
    const ultimo = new Date(a, m, 0).getDate();
    let hasta = mes + "-" + p2(ultimo);
    const hoy = hoyISO();
    if (hasta > hoy) hasta = hoy;
    return { desde: mes + "-01", hasta, nombre: MESES[m - 1] + " de " + a };
}

export function montarInformeMensual() {
    if (montado) return;
    montado = true;
    const d = new Date();
    $("im-mes").value = d.getFullYear() + "-" + p2(d.getMonth() + 1);
    $("im-generar").addEventListener("click", generar);
    $("im-excel").addEventListener("click", () => conXLSX(exportar));
    $("im-imprimir").addEventListener("click", imprimir);
}

async function leerArchivo(archivo) {
    const XLSX = await cargarXLSX();
    const libro = XLSX.read(await archivo.arrayBuffer(), { type: "array", cellDates: true });
    // La hoja que parezca la planilla (con FECHA y MUELLE); si no, la primera.
    for (const nombre of libro.SheetNames) {
        const matriz = XLSX.utils.sheet_to_json(libro.Sheets[nombre], { header: 1, raw: true, defval: null });
        try { return { hoja: nombre, ...leerPlanilla(matriz) }; } catch { /* siguiente hoja */ }
    }
    throw new Error("El archivo no tiene una hoja con los encabezados de Control Muelles (FECHA, MUELLE, PLACA…).");
}

async function generar() {

    const mes = $("im-mes").value;
    if (!/^\d{4}-\d{2}$/.test(mes)) { $("im-estado").textContent = "Elige un mes."; return; }
    const rango = rangoDelMes(mes);
    if (rango.desde > rango.hasta) { $("im-estado").textContent = "Ese mes todavía no empieza."; return; }

    const archivo = $("im-archivo").files[0] || null;
    $("im-generar").disabled = true;
    $("im-estado").innerHTML = '<i class="ti ti-loader-2 pk-gira"></i> Generando el informe de ' + escapar(rango.nombre) + "… (unos 15 segundos)";

    try {
        const [wms, planilla] = await Promise.all([
            supabase.functions.invoke(FUNCION_PICKING, { body: { desde: rango.desde, hasta: rango.hasta } }).then(async ({ data, error }) => {
                if (error) {
                    let detalle = error.message;
                    try { detalle = (await error.context.json()).error || detalle; } catch { /* sin cuerpo */ }
                    throw new Error(detalle);
                }
                if (data && data.error) throw new Error(data.error);
                return data;
            }),
            archivo ? leerArchivo(archivo) : Promise.resolve(null)
        ]);

        informe = armar(rango, wms, planilla, archivo && archivo.name);
        pintar(informe);
        $("im-estado").textContent = "Informe listo · " + new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
        $("im-excel").disabled = false;
        $("im-imprimir").disabled = false;

    } catch (e) {
        console.error("[informe mensual]", e);
        $("im-estado").innerHTML = '<span class="pk-error"><i class="ti ti-alert-triangle"></i> ' + escapar(e.message || "No se pudo generar el informe") + "</span>";
    } finally {
        $("im-generar").disabled = false;
    }
}

function armar(rango, wms, planilla, nombreArchivo) {

    const filtros = { desde: rango.desde, hasta: rango.hasta };
    const mov = wms.movimientos || null;
    const picking = resumirPicking(wms.filas, filtros, new Date(), mov && mov.pedidos);
    const movs = resumirMovimientos(mov, filtros);

    // WMS por día: tareas y líneas + cajas y estibas.
    const dias = new Map();
    const dia = (d) => {
        if (!dias.has(d)) dias.set(d, { dia: d, tareas: 0, lineas: 0, cajasDesp: 0, estibasDesp: 0, cajasRec: 0, estibasRec: 0 });
        return dias.get(d);
    };
    for (const d of picking.dias) { dia(d.clave).tareas = d.completas; dia(d.clave).lineas = d.lineas; }
    for (const d of movs.dias) {
        const x = dia(d.dia);
        x.cajasDesp = d.salida.cajas; x.estibasDesp = d.salida.estibas;
        x.cajasRec = d.entrada.cajas; x.estibasRec = d.entrada.estibas;
    }

    const conPlanilla = planilla
        ? {
            archivo: nombreArchivo,
            hoja: planilla.hoja,
            descartadas: planilla.descartadas,
            resumen: resumirPlanilla(planilla.registros, filtros),
            fuera: planilla.registros.filter((r) => r.dia < rango.desde || r.dia > rango.hasta).length,
            conciliacion: conciliar(planilla.registros, mov, { bodega: BODEGA_PLANILLA, ...filtros })
        }
        : null;

    return {
        rango,
        generado: new Date(),
        picking,
        movs,
        diasWms: [...dias.values()].sort((a, b) => (a.dia < b.dia ? -1 : 1)),
        truncado: !!(wms.truncado || (mov && mov.truncado)),
        planilla: conPlanilla
    };
}

/* ── PINTAR ─────────────────────────────────────────────── */

function tabla(cabeceras, filas, vacio = "Sin datos") {
    return '<div class="table-wrap"><table><thead><tr>' + cabeceras.map((c) => "<th>" + c + "</th>").join("") +
        "</tr></thead><tbody>" +
        (filas.length ? filas.map((f) => "<tr>" + f.map((c) => "<td>" + c + "</td>").join("") + "</tr>").join("")
                      : '<tr><td colspan="' + cabeceras.length + '" style="text-align:center;color:var(--text-3);">' + vacio + "</td></tr>") +
        "</tbody></table></div>";
}

function tarjetas(lista) {
    return '<div class="im-tarjetas">' + lista.map(([valor, etiqueta]) =>
        '<div class="im-tarjeta"><div class="im-valor">' + valor + '</div><div class="im-etiqueta">' + etiqueta + "</div></div>"
    ).join("") + "</div>";
}

const titulo = (t, nota = "") => '<h3 class="im-titulo">' + t + "</h3>" + (nota ? '<p class="form-hint">' + nota + "</p>" : "");

function pintar(inf) {

    const p = inf.picking, t = p.total, m = inf.movs;
    let h = "";

    h += '<div class="im-encabezado"><div><h2>Informe mensual · ' + escapar(inf.rango.nombre) + "</h2>" +
         '<div class="form-hint">Del ' + inf.rango.desde + " al " + inf.rango.hasta + " · generado el " +
         inf.generado.toLocaleString("es-CO") + "</div></div><strong>INLOTRANS</strong></div>";
    if (inf.truncado) h += '<p class="pk-error">Ojo: la consulta llegó al máximo de páginas; algunos totales pueden estar incompletos.</p>';

    // 1. WMS
    h += titulo("1. Operación en el WMS (todas las bodegas)");
    h += tarjetas([
        [num(t.completas), "Tareas completadas"],
        [num(t.lineas), "Líneas"],
        [num(p.usuarios.length), "Operarios"],
        [formatoMinutos(t.promedioMin), "Prom. por tarea"],
        [num(t.lineasPorHora, 1), "Líneas por hora"],
        [num(m.total.salida.cajas), "Cajas despachadas"],
        [num(m.total.salida.estibas), "Estibas despachadas"],
        [num(m.total.entrada.cajas), "Cajas recibidas"],
        [num(m.total.entrada.estibas), "Estibas recibidas"]
    ]);

    // Por bodega (sin ajustes)
    const bodegas = new Map();
    for (const d of m.documentos) {
        if (d.ajuste) continue;
        if (!bodegas.has(d.bodega)) bodegas.set(d.bodega, { cs: 0, es: 0, ce: 0, ee: 0 });
        const b = bodegas.get(d.bodega);
        if (d.sentido === "salida") { b.cs += d.cajas; b.es += d.estibas; } else { b.ce += d.cajas; b.ee += d.estibas; }
    }
    h += titulo("Cajas y estibas por bodega", "Sin ajustes de inventario.");
    h += tabla(["Bodega", "Cajas despachadas", "Estibas despachadas", "Cajas recibidas", "Estibas recibidas"],
        [...bodegas].sort().map(([b, x]) => ["<strong>" + escapar(b) + "</strong>", num(x.cs), num(x.es), num(x.ce), num(x.ee)]));

    h += titulo("Por tipo de tarea");
    h += tabla(["Tipo", "Tareas", "Líneas", "Cajas (picking)", "Tiempo total", "Prom. / tarea", "Líneas / hora"],
        p.tipos.map((g) => [escapar(g.clave), num(g.completas), num(g.lineas), num(g.cajas), formatoMinutos(g.minutos), formatoMinutos(g.promedioMin), num(g.lineasPorHora, 1)]));

    h += titulo("Productividad por operario", "Cajas y estibas: las de los pedidos despachados, repartidas según las líneas que hizo cada uno.");
    h += tabla(["#", "Operario", "Tareas", "Líneas", "Cajas (picking)", "Estibas (picking)", "Cajas auditadas", "Tiempo trabajado", "Líneas / hora", "Cajas / hora"],
        p.usuarios.map((u, i) => [i + 1, "<strong>" + escapar(u.clave) + "</strong>", num(u.completas), num(u.lineas), num(u.cajas), num(u.estibas, 1),
            num(u.cajasAuditadas), formatoMinutos(u.minutos), num(u.lineasPorHora, 1), num(u.cajasPorHora, 1)]));

    h += titulo("Día a día (WMS)");
    h += tabla(["Día", "Tareas", "Líneas", "Cajas despachadas", "Estibas despachadas", "Cajas recibidas", "Estibas recibidas"],
        inf.diasWms.map((d) => [d.dia, num(d.tareas), num(d.lineas), num(d.cajasDesp), num(d.estibasDesp), num(d.cajasRec), num(d.estibasRec)]));

    // 2. Planilla
    const pl = inf.planilla;
    if (!pl) {
        h += titulo("2. Control de muelles " + BODEGA_PLANILLA, "No se adjuntó la planilla. Adjúntala y vuelve a generar para incluirla.");
    } else {
        const r = pl.resumen, rt = r.total;
        h += titulo("2. Control de muelles " + BODEGA_PLANILLA + " (planilla)",
            escapar(pl.archivo || "") + " · hoja «" + escapar(pl.hoja) + "» · " + num(r.registros) + " vehículos del mes" +
            (pl.fuera ? " · " + num(pl.fuera) + " filas de otros meses no se cuentan" : "") +
            (pl.descartadas.length ? " · " + pl.descartadas.length + " filas sin fecha válida (ver Excel)" : ""));
        h += tarjetas([
            [num(rt.vehiculos), "Vehículos atendidos"],
            [num(rt.cargues), "Cargues"],
            [num(rt.descargues), "Descargues"],
            [num(rt.cajas), "Cajas"],
            [num(rt.estibas), "Estibas"],
            [formatoMinutos(rt.promedioMin), "Tiempo prom. en muelle"],
            [formatoMinutos(rt.medianaMin), "Tiempo típico (mediana)"]
        ]);
        if (rt.atipicos) h += '<p class="form-hint">' + num(rt.atipicos) + " vehículo(s) con más de 12 h en muelle (hora probablemente mal escrita): cuentan, pero no entran en los tiempos.</p>";

        const fila = (g) => [num(g.vehiculos), num(g.cargues), num(g.descargues), num(g.cajas), num(g.estibas), formatoMinutos(g.minutos), formatoMinutos(g.promedioMin), formatoMinutos(g.medianaMin)];
        const cab = ["Vehículos", "Cargues", "Descargues", "Cajas", "Estibas", "Tiempo total", "Prom. por vehículo", "Mediana"];

        h += titulo("Por tipo de operación");
        h += tabla(["Operación"].concat(cab), r.operaciones.map((g) => [escapar(g.clave)].concat(fila(g))));
        h += titulo("Por muelle");
        h += tabla(["Muelle"].concat(cab), r.muelles.map((g) => ["<strong>" + escapar(g.clave) + "</strong>"].concat(fila(g))));
        h += titulo("Por quien reporta");
        h += tabla(["Reporta"].concat(cab), r.reporta.map((g) => [escapar(g.clave)].concat(fila(g))));
        h += titulo("Por responsable de la información");
        h += tabla(["Responsable"].concat(cab), r.responsables.map((g) => [escapar(g.clave)].concat(fila(g))));
        h += titulo("Día a día (planilla)");
        h += tabla(["Día"].concat(cab), r.dias.map((g) => [g.clave].concat(fila(g))));

        h += titulo("Planilla frente al WMS · " + BODEGA_PLANILLA,
            "Cajas por día. No tienen que cuadrar exacto (el WMS registra al confirmar el documento y la planilla al atender el vehículo), pero una diferencia grande es para revisar.");
        const dif = (a, b) => {
            const d = a - b;
            const fuerte = Math.abs(d) > Math.max(200, 0.2 * Math.max(a, b));
            return '<span class="' + (fuerte ? "pk-error" : "") + '">' + (d > 0 ? "+" : "") + num(d) + "</span>";
        };
        h += tabla(["Día", "Cargue (planilla)", "Despachado (WMS)", "Diferencia", "Descargue (planilla)", "Recibido (WMS)", "Diferencia"],
            pl.conciliacion.map((c) => [c.dia, num(c.planillaCargue), num(c.wmsDespachado), dif(c.planillaCargue, c.wmsDespachado),
                num(c.planillaDescargue), num(c.wmsRecibido), dif(c.planillaDescargue, c.wmsRecibido)]));
    }

    $("im-informe").innerHTML = h;
}

/* ── IMPRIMIR / EXCEL ───────────────────────────────────── */

function imprimir() {
    if (!informe) return;
    document.body.classList.add("im-imprimiendo");
    const quitar = () => { document.body.classList.remove("im-imprimiendo"); window.removeEventListener("afterprint", quitar); };
    window.addEventListener("afterprint", quitar);
    window.print();
}

function exportar() {
    if (!informe) return;
    const X = window.XLSX;
    const libro = X.utils.book_new();
    const hoja = (filas, nombre) => X.utils.book_append_sheet(libro, X.utils.json_to_sheet(filas.length ? filas : [{ "Sin datos": "" }]), nombre);
    const h = (v) => (v == null || !Number.isFinite(v) ? "" : Math.round(v * 10) / 10);
    const p = informe.picking, m = informe.movs;

    hoja([
        { Concepto: "Mes", Valor: informe.rango.nombre },
        { Concepto: "Desde", Valor: informe.rango.desde },
        { Concepto: "Hasta", Valor: informe.rango.hasta },
        { Concepto: "Tareas completadas", Valor: p.total.completas },
        { Concepto: "Lineas", Valor: p.total.lineas },
        { Concepto: "Operarios", Valor: p.usuarios.length },
        { Concepto: "Min. prom. por tarea", Valor: h(p.total.promedioMin) },
        { Concepto: "Lineas por hora", Valor: h(p.total.lineasPorHora) },
        { Concepto: "Cajas despachadas", Valor: m.total.salida.cajas },
        { Concepto: "Estibas despachadas", Valor: m.total.salida.estibas },
        { Concepto: "Cajas recibidas", Valor: m.total.entrada.cajas },
        { Concepto: "Estibas recibidas", Valor: m.total.entrada.estibas }
    ].concat(informe.planilla ? [
        { Concepto: "Vehiculos en muelle (planilla " + BODEGA_PLANILLA + ")", Valor: informe.planilla.resumen.total.vehiculos },
        { Concepto: "Cajas (planilla)", Valor: informe.planilla.resumen.total.cajas },
        { Concepto: "Estibas (planilla)", Valor: informe.planilla.resumen.total.estibas },
        { Concepto: "Min. prom. en muelle (planilla)", Valor: h(informe.planilla.resumen.total.promedioMin) }
    ] : []), "Resumen");

    hoja(p.usuarios.map((u) => ({
        Operario: u.clave, Tareas: u.completas, Lineas: u.lineas, "Cajas picking": Math.round(u.cajas), "Estibas picking": h(u.estibas),
        "Cajas auditadas": Math.round(u.cajasAuditadas), "Minutos trabajados": h(u.minutos),
        "Lineas por hora": h(u.lineasPorHora), "Cajas por hora": h(u.cajasPorHora)
    })), "WMS por operario");
    hoja(p.tipos.map((g) => ({ Tipo: g.clave, Tareas: g.completas, Lineas: g.lineas, Cajas: Math.round(g.cajas), Minutos: h(g.minutos), "Min. prom.": h(g.promedioMin) })), "WMS por tipo");
    hoja(informe.diasWms.map((d) => ({ Dia: d.dia, Tareas: d.tareas, Lineas: d.lineas, "Cajas despachadas": d.cajasDesp,
        "Estibas despachadas": d.estibasDesp, "Cajas recibidas": d.cajasRec, "Estibas recibidas": d.estibasRec })), "WMS por dia");
    hoja(m.documentos.map((d) => ({ Bodega: d.bodega, Movimiento: d.sentido === "salida" ? "Despachado" : "Recibido", Documento: d.documento,
        Cajas: d.cajas, Estibas: d.estibas, "Suma en totales": d.ajuste ? "No (ajuste)" : "Si" })), "Cajas por bodega");

    const pl = informe.planilla;
    if (pl) {
        const g = (clave) => (x) => ({ [clave]: x.clave, Vehiculos: x.vehiculos, Cargues: x.cargues, Descargues: x.descargues,
            Cajas: x.cajas, Estibas: x.estibas, Minutos: h(x.minutos), "Min. prom. por vehiculo": h(x.promedioMin), "Min. mediana": h(x.medianaMin), "Mas de 12 h": x.atipicos });
        hoja(pl.resumen.muelles.map(g("Muelle")), "Muelles");
        hoja(pl.resumen.reporta.map(g("Reporta")), "Reporta");
        hoja(pl.resumen.responsables.map(g("Responsable")), "Responsables");
        hoja(pl.resumen.dias.map(g("Dia")), "Planilla por dia");
        hoja(pl.conciliacion.map((c) => ({ Dia: c.dia, "Cargue planilla": c.planillaCargue, "Despachado WMS": c.wmsDespachado,
            "Dif. cargue": c.planillaCargue - c.wmsDespachado, "Descargue planilla": c.planillaDescargue, "Recibido WMS": c.wmsRecibido,
            "Dif. descargue": c.planillaDescargue - c.wmsRecibido })), "Planilla vs WMS " + BODEGA_PLANILLA);
        if (pl.descartadas.length) hoja(pl.descartadas.map((d) => ({ "Fila del Excel": d.fila, Motivo: d.motivo })), "Filas descartadas");
    }

    X.writeFile(libro, "informe_mensual_" + informe.rango.desde.slice(0, 7) + ".xlsx");
}
