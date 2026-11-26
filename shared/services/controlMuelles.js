/* =========================================================
   INLOTRANS
   Planilla "Control Muelles" (Excel que se diligencia a mano en J3)

   Una fila por vehículo atendido en un muelle:
     FECHA · MUELLE · PLACA · LLEGADA · SALIDA · TOTAL ·
     CARGUE /DESCARGUE · REPORTA · RESPONSABLE INFO · DESCRIPCION ·
     ESTIBAS · CAJAS · UNIDADES · BOLSAS · KG PLASTICO · OTROS ·
     TIPO / MATERIAL

   Se lee en el navegador al generar el informe mensual y no se
   guarda. Como es a mano, viene con variantes ("CARGUE  ", "GARGUE",
   "DESCRAGUE"; fechas "17/11//2026") y se normaliza aquí.

   No se habla con nadie: recibe las filas ya leídas del Excel (una
   matriz, como XLSX.utils.sheet_to_json(hoja, { header: 1 })).
   ========================================================= */

export const MAX_MINUTOS_MUELLE = 12 * 60;

const COLUMNAS = {
    fecha: ["FECHA"],
    muelle: ["MUELLE"],
    placa: ["PLACA"],
    llegada: ["LLEGADA", "HORA LLEGADA"],
    salida: ["SALIDA", "HORA SALIDA"],
    total: ["TOTAL", "TIEMPO"],
    operacion: ["CARGUE/DESCARGUE", "CARGUE / DESCARGUE", "OPERACION"],
    reporta: ["REPORTA"],
    responsable: ["RESPONSABLE INFO", "RESPONSABLE"],
    descripcion: ["DESCRIPCION"],
    estibas: ["ESTIBAS"],
    cajas: ["CAJAS"],
    unidades: ["UNIDADES"],
    bolsas: ["BOLSAS"],
    kg: ["KG PLASTICO", "KG"],
    otros: ["OTROS"],
    material: ["TIPO / MATERIAL", "TIPO/MATERIAL", "MATERIAL"]
};

const llave = (t) => String(t == null ? "" : t)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/\s+/g, " ").replace(/\s*\/\s*/g, "/").trim();

const p2 = (n) => String(n).padStart(2, "0");

function diaLocal(d) {
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
}

/* Fecha: Date del Excel, o texto escrito a mano ("17/11//2026",
   "20/112026", "2026-11-20"). null si no se entiende o es de 1900
   (una celda vacía o un número que Excel tomó por fecha). */
export function leerFecha(v) {
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
        return v.getFullYear() >= 2000 ? diaLocal(v) : null;
    }
    if (typeof v === "number" && v > 36526 && v < 80000) {           // serial de Excel (≥ 2000)
        return diaLocal(new Date(Math.round((v - 25569) * 86400000) + new Date().getTimezoneOffset() * 60000));
    }
    const t = String(v == null ? "" : v).trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
    if (m) return m[1] + "-" + p2(m[2]) + "-" + p2(m[3]);
    const digitos = t.replace(/\D/g, "");
    m = /^(\d{1,2})\D+(\d{1,2})\D+(\d{4})$/.exec(t);
    if (m) return m[3] + "-" + p2(m[2]) + "-" + p2(m[1]);
    if (digitos.length === 8) return digitos.slice(4) + "-" + digitos.slice(2, 4) + "-" + digitos.slice(0, 2);
    return null;
}

/* Hora del día en minutos: Date (Excel guarda las horas como fecha
   de 1899/1900), fracción de día, o "07:15". */
export function leerHora(v) {
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.getHours() * 60 + v.getMinutes() + v.getSeconds() / 60;
    if (typeof v === "number" && v >= 0 && v < 1) return v * 1440;
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v == null ? "" : v).trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function leerOperacion(v) {
    const t = llave(v);
    if (/^DES/.test(t)) return "Descargue";
    if (/^(CAR|GAR|CRA)/.test(t)) return "Cargue";
    return "Sin dato";
}

const numero = (v) => {
    if (v == null || v === "") return 0;
    const n = Number(String(v).replace(/[^\d.,-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
};

const nombre = (v) => llave(v) || "SIN NOMBRE";

/*
    Matriz del Excel → registros. Busca la fila de encabezados (la que
    tiene FECHA y MUELLE) en las primeras 10, así no importa si arriba
    hay un título.
*/
export function leerPlanilla(matriz) {

    const filas = Array.isArray(matriz) ? matriz : [];
    let inicio = -1;
    let indice = {};

    for (let i = 0; i < Math.min(10, filas.length); i++) {
        const encabezados = (filas[i] || []).map(llave);
        if (encabezados.includes("FECHA") && encabezados.includes("MUELLE")) {
            inicio = i;
            for (const [campo, nombres] of Object.entries(COLUMNAS)) {
                const j = encabezados.findIndex((h) => nombres.map(llave).includes(h));
                if (j !== -1) indice[campo] = j;
            }
            break;
        }
    }
    if (inicio === -1) throw new Error("No encontré los encabezados de la planilla (FECHA, MUELLE, PLACA…).");

    const registros = [];
    const descartadas = [];

    for (let i = inicio + 1; i < filas.length; i++) {
        const f = filas[i] || [];
        const celda = (campo) => (indice[campo] == null ? null : f[indice[campo]]);
        if (!f.some((c) => c != null && String(c).trim() !== "")) continue;

        const dia = leerFecha(celda("fecha"));
        if (!dia) { descartadas.push({ fila: i + 1, motivo: "fecha no válida: " + String(celda("fecha")) }); continue; }

        const llegada = leerHora(celda("llegada"));
        const salida = leerHora(celda("salida"));
        let minutos = null;
        if (llegada != null && salida != null) {
            minutos = salida - llegada;
            if (minutos < 0) minutos += 1440;               // pasó la medianoche
        } else {
            minutos = leerHora(celda("total"));
        }
        if (minutos != null && minutos > 1440) minutos = null;
        // Más de 12 h en un muelle es casi siempre una hora mal escrita:
        // el vehículo cuenta, pero su tiempo no entra en los promedios.
        const atipico = minutos != null && minutos > MAX_MINUTOS_MUELLE;
        if (atipico) minutos = null;

        registros.push({
            fila: i + 1,
            dia,
            muelle: String(celda("muelle") == null ? "" : celda("muelle")).trim() || "—",
            placa: llave(celda("placa")).replace(/\s/g, ""),
            operacion: leerOperacion(celda("operacion")),
            reporta: nombre(celda("reporta")),
            responsable: nombre(celda("responsable")),
            descripcion: llave(celda("descripcion")),
            material: llave(celda("material")),
            minutos,
            atipico,
            estibas: numero(celda("estibas")),
            cajas: numero(celda("cajas")),
            unidades: numero(celda("unidades")),
            bolsas: numero(celda("bolsas")),
            kg: numero(celda("kg")),
            otros: numero(celda("otros"))
        });
    }

    return { registros, descartadas };
}

function nuevo(clave) {
    return { clave, vehiculos: 0, cargues: 0, descargues: 0, cajas: 0, estibas: 0, unidades: 0, minutos: 0, conTiempo: 0, atipicos: 0, tiempos: [] };
}

function sumar(g, r) {
    g.vehiculos++;
    if (r.operacion === "Cargue") g.cargues++;
    if (r.operacion === "Descargue") g.descargues++;
    g.cajas += r.cajas;
    g.estibas += r.estibas;
    g.unidades += r.unidades + r.bolsas + r.otros;
    if (r.minutos != null) { g.minutos += r.minutos; g.conTiempo++; g.tiempos.push(r.minutos); }
    if (r.atipico) g.atipicos++;
}

function mediana(lista) {
    if (!lista.length) return null;
    const o = [...lista].sort((a, b) => a - b);
    const m = Math.floor(o.length / 2);
    return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
}

const cerrar = (g) => {
    const { tiempos, ...resto } = g;
    return { ...resto, promedioMin: g.conTiempo ? g.minutos / g.conTiempo : null, medianaMin: mediana(tiempos) };
};

/* El resumen del mes: por muelle, por quien reporta, por responsable,
   por día y por tipo de operación. */
export function resumirPlanilla(registros, { desde = "", hasta = "" } = {}) {

    const del = registros.filter((r) => (!desde || r.dia >= desde) && (!hasta || r.dia <= hasta));
    const total = nuevo("total");
    const mapas = { muelles: new Map(), reporta: new Map(), responsables: new Map(), dias: new Map(), operaciones: new Map() };
    const en = (m, k) => { if (!m.has(k)) m.set(k, nuevo(k)); return m.get(k); };

    for (const r of del) {
        sumar(total, r);
        sumar(en(mapas.muelles, r.muelle), r);
        sumar(en(mapas.reporta, r.reporta), r);
        sumar(en(mapas.responsables, r.responsable), r);
        sumar(en(mapas.dias, r.dia), r);
        sumar(en(mapas.operaciones, r.operacion), r);
    }

    const porVolumen = (a, b) => b.cajas - a.cajas || b.vehiculos - a.vehiculos;
    const porClave = (a, b) => (String(a.clave).localeCompare(String(b.clave), "es", { numeric: true }));

    return {
        registros: del.length,
        total: cerrar(total),
        muelles: [...mapas.muelles.values()].map(cerrar).sort(porClave),
        reporta: [...mapas.reporta.values()].map(cerrar).sort(porVolumen),
        responsables: [...mapas.responsables.values()].map(cerrar).sort(porVolumen),
        dias: [...mapas.dias.values()].map(cerrar).sort(porClave),
        operaciones: [...mapas.operaciones.values()].map(cerrar).sort(porVolumen)
    };
}

/*
    Planilla contra WMS, día por día, para una bodega: lo cargado en la
    planilla frente a lo que el WMS registró como despachado, y lo
    descargado frente a lo recibido. No tienen por qué cuadrar exacto
    (el WMS registra al confirmar el documento, la planilla al atender
    el vehículo), pero una diferencia grande es algo para revisar.
*/
export function conciliar(registros, movimientos, { bodega = "J3", desde = "", hasta = "" } = {}) {

    const dias = new Map();
    const fila = (d) => {
        if (!dias.has(d)) dias.set(d, { dia: d, planillaCargue: 0, wmsDespachado: 0, planillaDescargue: 0, wmsRecibido: 0 });
        return dias.get(d);
    };
    const dentro = (d) => (!desde || d >= desde) && (!hasta || d <= hasta);

    for (const r of registros) {
        if (!dentro(r.dia)) continue;
        if (r.operacion === "Cargue") fila(r.dia).planillaCargue += r.cajas;
        if (r.operacion === "Descargue") fila(r.dia).planillaDescargue += r.cajas;
    }
    for (const m of (movimientos && movimientos.resumen) || []) {
        if (m.bodega !== bodega || !dentro(m.dia) || /ajuste/i.test(m.documento)) continue;
        if (m.sentido === "salida") fila(m.dia).wmsDespachado += m.cajas;
        else fila(m.dia).wmsRecibido += m.cajas;
    }

    return [...dias.values()].sort((a, b) => (a.dia < b.dia ? -1 : 1));
}
