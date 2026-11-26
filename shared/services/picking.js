/* =========================================================
   INLOTRANS
   Picking: tiempos y productividad (vista System.PickTasks de Iztech)

   Los datos llegan de la función de Supabase `picking` (el token de
   Iztech vive allá, nunca en el navegador). Aquí solo se calcula:
   no se habla con nadie, para poder probarlo con filas de mentira.

   Una fila es una TAREA del WMS:
       ctst_name            tipo: Picking, Auditoria Picking, Reposicion…
       ctsk_task_state      Complete | Running | Waiting | Pending
       ctsk_task_user       el usuario del WMS que la hizo
       ctsk_lines           líneas (referencias) de la tarea
       ctsk_waiting_date    cuándo se activó
       ctsk_running_date    cuándo se empezó
       ctsk_complete_date   cuándo se terminó
       ctti_time_els_value  tiempo que el WMS le midió ("HH:MM:SS.ffff")
       ctsk_organization_id la organización (la vista no trae la bodega)

   Las fechas vienen sin zona horaria: son hora local de la bodega y
   así se tratan.

   CAJAS Y ESTIBAS: las tareas no las traen. Salen de las transacciones
   del WMS (salidas y entradas), que la función ya manda resumidas en
   `movimientos` (ver resumirMovimientos). Para el operario, las cajas
   de cada pedido despachado se reparten entre las tareas de picking
   de ese pedido según las líneas que hizo cada una (y aparte, igual,
   entre las de auditoría): es un reparto, no un conteo por persona,
   porque el WMS no dice quién movió cada caja.
   ========================================================= */

// Una tarea de más de esto es un olvido de cerrarla, no trabajo:
// cuenta como tarea, pero no entra en promedios ni en líneas/hora.
export const MAX_MINUTOS_TAREA = 12 * 60;

const ESTADOS_ABIERTOS = ["Running", "Waiting", "Pending"];

function fecha(texto) {
    if (!texto) return null;
    // Sin zona: "2026-11-26T08:15:00.123" se lee como hora local.
    const d = new Date(String(texto).replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
}

/* "00:08:50.787626" o "1.02:03:04" → minutos. */
export function minutosDeTiempo(texto) {
    if (texto == null || texto === "") return null;
    const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(texto).trim());
    if (!m) return null;
    return (Number(m[1] || 0) * 1440) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 60;
}

/* La fecha que ubica la tarea en el calendario: cuándo terminó, si
   terminó; si no, cuándo empezó o se activó. */
export function fechaDeTarea(f) {
    return fecha(f.ctsk_complete_date) || fecha(f.ctsk_running_date) || fecha(f.ctsk_waiting_date);
}

/* Lo que tardó, en minutos. Primero lo que midió el WMS; si no lo
   midió, de empezar a terminar. null si no se puede saber. */
export function duracionDeTarea(f) {
    const medido = minutosDeTiempo(f.ctti_time_els_value);
    if (medido != null) return medido;
    const ini = fecha(f.ctsk_running_date);
    const fin = fecha(f.ctsk_complete_date);
    if (!ini || !fin) return null;
    const min = (fin - ini) / 60000;
    return min >= 0 ? min : null;
}

function diaLocal(d) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function nuevoGrupo(clave) {
    return { clave, tareas: 0, completas: 0, lineas: 0, minutos: 0, conTiempo: 0, porTipo: {},
             cajas: 0, estibas: 0, cajasAuditadas: 0, conPedido: 0, minutosPicking: 0 };
}

const normal = (t) => String(t || "").replace(/\s+/g, " ").trim().toUpperCase();

/* El pedido de una tarea, con el mismo formato que DeliveryNumber de
   las salidas: "WNW948 ANT CAMPIN 2026-11-25 PKGPISO-P1" → sin la
   regla del final; "994682  -  Santo Domingo" → lo de antes del " - ". */
export function pedidoDeTarea(f) {
    let n = String(f.ctsk_task_name || "").split("  -  ")[0];
    const regla = String(f.crul_name || "");
    if (regla && regla.indexOf("{") === -1 && normal(n).endsWith(normal(regla))) {
        n = normal(n).slice(0, -normal(regla).length);
    }
    return normal(n);
}

function sumarAGrupo(g, t) {
    g.tareas++;
    g.porTipo[t.tipo] = (g.porTipo[t.tipo] || 0) + 1;
    if (!t.completa) return;
    g.completas++;
    g.lineas += t.lineas;
    g.cajas += t.cajas;
    g.estibas += t.estibas;
    g.cajasAuditadas += t.cajasAuditadas;
    if (t.conPedido) g.conPedido++;
    if (t.minutos != null) { g.minutos += t.minutos; g.conTiempo++; }
    if (t.minutos != null && t.esPicking) g.minutosPicking += t.minutos;
}

function cerrarGrupo(g) {
    return {
        ...g,
        promedioMin: g.conTiempo ? g.minutos / g.conTiempo : null,
        lineasPorHora: g.minutos > 0 ? g.lineas / (g.minutos / 60) : null,
        tareasPorHora: g.minutos > 0 ? g.conTiempo / (g.minutos / 60) : null,
        // Solo contra el tiempo de picking: la auditoría no mueve esas cajas.
        cajasPorHora: g.minutosPicking > 0 && g.cajas > 0 ? g.cajas / (g.minutosPicking / 60) : null
    };
}

/* Las filas crudas → tareas con lo que se necesita, ya validado. */
export function normalizarTareas(filas) {
    return (filas || []).map(function (f) {
        const cuando = fechaDeTarea(f);
        const dur = duracionDeTarea(f);
        const estado = String(f.ctsk_task_state || "");
        return {
            id: f.ctsk_id,
            nombre: f.ctsk_task_name || "",
            descripcion: f.ctsk_task_description || "",
            tipo: f.ctst_name || "Sin tipo",
            estado,
            completa: estado === "Complete",
            abierta: ESTADOS_ABIERTOS.indexOf(estado) !== -1,
            usuario: f.ctsk_task_user || "",
            organizacion: f.ctsk_organization_id == null ? "" : String(f.ctsk_organization_id),
            regla: f.crul_name || "",
            lineas: Number(f.ctsk_lines) || 0,
            cuando,
            dia: cuando ? diaLocal(cuando) : "",
            hora: cuando ? cuando.getHours() : null,
            activada: fecha(f.ctsk_waiting_date),
            iniciada: fecha(f.ctsk_running_date),
            minutos: dur != null && dur <= MAX_MINUTOS_TAREA ? dur : null,
            atipica: dur != null && dur > MAX_MINUTOS_TAREA,
            pedido: pedidoDeTarea(f),
            esPicking: /picking/i.test(f.ctst_name || "") && !/auditor/i.test(f.ctst_name || ""),
            cajas: 0, estibas: 0, cajasAuditadas: 0, conPedido: false
        };
    });
}

/* Reparte las cajas y estibas de cada pedido entre sus tareas
   completas, según las líneas (sin líneas, por partes iguales). */
function repartirCajas(tareas, pedidos) {
    if (!pedidos) return;
    const porPedido = new Map();
    for (const t of tareas) {
        if (!t.completa || !t.pedido || !pedidos[t.pedido]) continue;
        const tipo = /auditor/i.test(t.tipo) ? "auditoria" : /picking/i.test(t.tipo) ? "picking" : null;
        if (!tipo) continue;
        const k = t.pedido + "|" + tipo;
        if (!porPedido.has(k)) porPedido.set(k, { tipo, pedido: pedidos[t.pedido], tareas: [] });
        porPedido.get(k).tareas.push(t);
    }
    for (const { tipo, pedido, tareas: lista } of porPedido.values()) {
        const lineas = lista.reduce((s, t) => s + t.lineas, 0);
        for (const t of lista) {
            const parte = lineas > 0 ? t.lineas / lineas : 1 / lista.length;
            t.conPedido = true;
            if (tipo === "picking") {
                t.cajas = pedido.cajas * parte;
                t.estibas = pedido.estibas * parte;
            } else {
                t.cajasAuditadas = pedido.cajas * parte;
            }
        }
    }
}

/*
    Cajas y estibas por bodega, tipo de documento y día (lo despachado y
    lo recibido). `resumen` viene de la función ya agrupado.
    Los ajustes de inventario no son movimiento físico: quedan en la
    tabla pero no suman en los totales.
*/
export function resumirMovimientos(movimientos, filtros = {}) {

    const filas = ((movimientos && movimientos.resumen) || []).filter(function (m) {
        if (filtros.desde && m.dia < filtros.desde) return false;
        if (filtros.hasta && m.dia > filtros.hasta) return false;
        if (filtros.bodega && m.bodega !== filtros.bodega) return false;
        return true;
    });

    const esAjuste = (m) => /ajuste/i.test(m.documento);
    const vacio = () => ({ cajas: 0, estibas: 0, otras: {} });
    const sumar = (g, m) => {
        g.cajas += m.cajas; g.estibas += m.estibas;
        for (const [u, c] of Object.entries(m.otras || {})) g.otras[u] = (g.otras[u] || 0) + c;
    };

    const total = { salida: vacio(), entrada: vacio() };
    const porDia = new Map();
    const porDoc = new Map();

    for (const m of filas) {
        const k = m.bodega + "|" + m.sentido + "|" + m.documento;
        if (!porDoc.has(k)) porDoc.set(k, { bodega: m.bodega, sentido: m.sentido, documento: m.documento, ajuste: esAjuste(m), ...vacio() });
        sumar(porDoc.get(k), m);
        if (esAjuste(m)) continue;
        sumar(total[m.sentido] || (total[m.sentido] = vacio()), m);
        if (!porDia.has(m.dia)) porDia.set(m.dia, { dia: m.dia, salida: vacio(), entrada: vacio() });
        sumar(porDia.get(m.dia)[m.sentido], m);
    }

    return {
        total,
        dias: [...porDia.values()].sort((a, b) => (a.dia < b.dia ? -1 : 1)),
        documentos: [...porDoc.values()].sort((a, b) =>
            (a.bodega < b.bodega ? -1 : a.bodega > b.bodega ? 1 : 0) || (a.sentido < b.sentido ? 1 : -1) || b.cajas - a.cajas),
        bodegas: [...new Set(((movimientos && movimientos.resumen) || []).map((m) => m.bodega))].sort()
    };
}

/*
    El resumen que pinta el apartado.

    filtros: { desde, hasta (YYYY-MM-DD, inclusive), organizacion, tipo }
    `ahora` se inyecta para las pruebas (cuánto lleva esperando una abierta).
*/
export function resumirPicking(filas, filtros = {}, ahora = new Date(), pedidos = null) {

    const todas = normalizarTareas(filas);
    repartirCajas(todas, pedidos);

    const tareas = todas.filter(function (t) {
        // Las abiertas se ven siempre: son lo que está pasando ahora.
        if (!t.abierta) {
            if (!t.dia) return false;
            if (filtros.desde && t.dia < filtros.desde) return false;
            if (filtros.hasta && t.dia > filtros.hasta) return false;
        }
        if (filtros.organizacion && t.organizacion !== filtros.organizacion) return false;
        if (filtros.tipo && t.tipo !== filtros.tipo) return false;
        return true;
    });

    const total = nuevoGrupo("total");
    const porUsuario = new Map();
    const porTipo = new Map();
    const porDia = new Map();
    const porOrg = new Map();
    const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, tareas: 0, lineas: 0 }));
    let atipicas = 0;

    function en(mapa, clave) {
        if (!mapa.has(clave)) mapa.set(clave, nuevoGrupo(clave));
        return mapa.get(clave);
    }

    for (const t of tareas) {
        if (t.abierta) continue;
        sumarAGrupo(total, t);
        sumarAGrupo(en(porTipo, t.tipo), t);
        sumarAGrupo(en(porOrg, t.organizacion || "—"), t);
        if (t.dia) sumarAGrupo(en(porDia, t.dia), t);
        if (t.usuario) sumarAGrupo(en(porUsuario, t.usuario), t);
        if (t.completa && t.hora != null) { porHora[t.hora].tareas++; porHora[t.hora].lineas += t.lineas; }
        if (t.atipica) atipicas++;
    }

    const abiertas = tareas
        .filter((t) => t.abierta)
        .map(function (t) {
            const desde = t.iniciada || t.activada;
            return { ...t, esperaMin: desde ? Math.max(0, (ahora - desde) / 60000) : null };
        })
        .sort((a, b) => (b.esperaMin || 0) - (a.esperaMin || 0));

    const porLineas = (a, b) => b.lineas - a.lineas || b.completas - a.completas;

    return {
        total: cerrarGrupo(total),
        usuarios: [...porUsuario.values()].map(cerrarGrupo).sort(porLineas),
        tipos: [...porTipo.values()].map(cerrarGrupo).sort(porLineas),
        organizaciones: [...porOrg.values()].map(cerrarGrupo).sort(porLineas),
        dias: [...porDia.values()].map(cerrarGrupo).sort((a, b) => (a.clave < b.clave ? -1 : 1)),
        horas: porHora,
        abiertas,
        enCurso: abiertas.filter((t) => t.estado === "Running").length,
        enEspera: abiertas.filter((t) => t.estado !== "Running").length,
        atipicas,
        opciones: {
            organizaciones: [...new Set(todas.map((t) => t.organizacion).filter(Boolean))].sort(),
            tipos: [...new Set(todas.map((t) => t.tipo))].sort()
        }
    };
}

export function formatoMinutos(min) {
    if (min == null || !Number.isFinite(min)) return "—";
    if (min < 1) return Math.round(min * 60) + " s";
    if (min < 60) return Math.round(min) + " min";
    const h = Math.floor(min / 60);
    const m = Math.round(min - h * 60);
    return h + " h " + String(m).padStart(2, "0") + " min";
}
