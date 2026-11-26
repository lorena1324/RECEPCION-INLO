/* =========================================================
   INLOTRANS
   Función de Supabase: picking (tareas del WMS de Iztech)

   El token de Iztech es una contraseña: vive SOLO aquí, como
   secreto de Supabase (IZTECH_TOKEN). El navegador nunca lo ve: el
   panel del administrador llama a esta función con su sesión y la
   función consulta Iztech.

   Quién puede: solo el ADMINISTRADOR (se le pregunta a la base con
   public.es_admin(), con la sesión de quien llama).

   GET/POST  /functions/v1/picking   { desde, hasta? }
       → { filas: [...], movimientos, desde, consultadoEn, paginas, total }
       Sin `hasta`: lo reciente (incluye tareas abiertas).
       Con `hasta`: rango cerrado para el informe mensual.

   La vista tiene más de medio millón de tareas, así que se piden de
   la más nueva hacia atrás (ctsk_id desc) y se para cuando una página
   entera ya es anterior a `desde`.

   Puesta en marcha (ver supabase/LEEME.md):
       supabase secrets set IZTECH_TOKEN=...
       supabase functions deploy picking
   ========================================================= */

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const URL_BASE = (Deno.env.get("IZTECH_URL_BASE") ||
    "https://zhllvr6nqg.execute-api.us-west-2.amazonaws.com/prod/views/").replace(/\/?$/, "/");
const VISTA = "System.PickTasks.List.View1";
const TOMA = 2500;
const MAX_PAGINAS = 40;          // 100.000 tareas: más que eso es pedir de más
const MAX_DIAS = 62;          // ~7 s por página de 2.500: 62 días caben holgados en el límite de la función
const COPIA_MS = 60_000;

const CAMPOS = [
    "ctsk_id", "ctsk_task_name", "ctsk_task_description", "ctst_name", "ctsk_task_state",
    "ctsk_task_user", "ctsk_lines", "ctsk_waiting_date", "ctsk_running_date",
    "ctsk_complete_date", "ctti_time_els_value", "ctsk_organization_id", "crul_name",
    "ctro_document_root"
];

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

function responder(cuerpo: unknown, estado = 200) {
    return new Response(JSON.stringify(cuerpo), {
        status: estado,
        headers: { ...CORS, "Content-Type": "application/json" }
    });
}

// Una copia por `desde`, y una sola consulta en curso: varios
// administradores abriendo el apartado no multiplican las llamadas.
const copias = new Map<string, { en: number; datos: unknown }>();
const enCurso = new Map<string, Promise<unknown>>();

function fechaMasNueva(f: Record<string, unknown>): string {
    return String(f.ctsk_complete_date || f.ctsk_running_date || f.ctsk_waiting_date || "");
}

async function pagina(token: string, skip: number) {
    return consulta(token, VISTA, { take: String(TOMA), skip: String(skip), orderby: "ctsk_id desc" });
}

async function consulta(token: string, vista: string, parametros: Record<string, string>) {
    const q = new URLSearchParams(parametros);
    const r = await fetch(URL_BASE + vista + "?" + q.toString(), {
        headers: { token, Accept: "application/json" },
        signal: AbortSignal.timeout(60_000)
    });
    if (!r.ok) throw new Error("Iztech respondió HTTP " + r.status);
    const cuerpo = await r.json();
    // Con el token mal puesto Iztech responde HTTP 200 con otro `code`.
    if (!cuerpo || cuerpo.code !== 200 || !Array.isArray(cuerpo.message)) {
        const detalle = typeof cuerpo?.message === "string" ? cuerpo.message : "respuesta sin filas";
        throw new Error("Iztech rechazó la consulta (code " + cuerpo?.code + ": " + detalle + ")");
    }
    return {
        filas: cuerpo.message as Record<string, unknown>[],
        total: Number(cuerpo.metadata?.resultset?.count) || null
    };
}

/* ── CAJAS Y ESTIBAS ─────────────────────────────────────────
   Salen de las transacciones del WMS (no de las tareas):
     User.BI.OutboundTransactions  lo despachado (salidas)
     User.BI.InboundTransactions   lo recibido (entradas)
   cajas   = suma de PrimaryQty en CARTON
   estibas = unidades de manejo (HandlingUnit) distintas
   otras   = lo que no viene en cajas (UND, KG…), aparte
   Se resume aquí, por día · bodega · tipo de documento, para no
   mandarle al navegador decenas de miles de filas. Las salidas se
   resumen además por pedido (DeliveryNumber), que es el mismo número
   de orden de la tarea de picking (ctro_document_root). */

const TOMA_MOV = 10000;
const MAX_PAGINAS_MOV = 20;

type Grupo = { cajas: number; otras: Record<string, number>; estibas: Set<string>; filas: number };
const nuevoGrupo = (): Grupo => ({ cajas: 0, otras: {}, estibas: new Set(), filas: 0 });

function sumar(g: Grupo, f: Record<string, unknown>) {
    const cantidad = Number(f.PrimaryQty);
    if (!Number.isFinite(cantidad)) return;
    g.filas++;
    const uom = String(f.PrimaryUomCode || "?");
    if (uom === "CARTON") g.cajas += cantidad;
    else g.otras[uom] = (g.otras[uom] || 0) + cantidad;
    if (f.HandlingUnit) g.estibas.add(String(f.HandlingUnit));
}

const cerrar = (g: Grupo) => ({ cajas: g.cajas, otras: g.otras, estibas: g.estibas.size, filas: g.filas });

async function movimientos(token: string, desde: string, sentido: "salida" | "entrada", hasta = "") {

    const vista = sentido === "salida" ? "User.BI.OutboundTransactions.List.View1" : "User.BI.InboundTransactions.List.View1";
    const columnas = "Id,TransactionDate,WarehouseCode,PrimaryQty,PrimaryUomCode,HandlingUnit,DocumentTypeName" +
        (sentido === "salida" ? ",DeliveryNumber" : "");

    const grupos = new Map<string, { dia: string; bodega: string; documento: string; g: Grupo }>();
    const pedidos = new Map<string, Grupo>();
    let paginas = 0;

    for (let skip = 0; paginas < MAX_PAGINAS_MOV; skip += TOMA_MOV) {
        // `desde` ya viene validado como AAAA-MM-DD: nada de texto libre en el where.
        const p = await consulta(token, vista, {
            take: String(TOMA_MOV), skip: String(skip), orderby: "Id desc",
            where: `"TransactionDate">='${desde}'` + (hasta ? ` AND "TransactionDate"<='${hasta}'` : ""), select: columnas
        });
        paginas++;
        for (const f of p.filas) {
            const dia = String(f.TransactionDate || "").slice(0, 10);
            const bodega = String(f.WarehouseCode || "—");
            const documento = String(f.DocumentTypeName || "—");
            const k = dia + "|" + bodega + "|" + documento;
            if (!grupos.has(k)) grupos.set(k, { dia, bodega, documento, g: nuevoGrupo() });
            sumar(grupos.get(k)!.g, f);
            if (sentido === "salida" && f.DeliveryNumber) {
                // Mismo formato que la clave del pedido en el navegador (shared/services/picking.js).
                const n = String(f.DeliveryNumber).replace(/\s+/g, " ").trim().toUpperCase();
                if (!pedidos.has(n)) pedidos.set(n, nuevoGrupo());
                sumar(pedidos.get(n)!, f);
            }
        }
        if (p.filas.length < TOMA_MOV) break;
    }

    return {
        resumen: [...grupos.values()].map((x) => ({ sentido, dia: x.dia, bodega: x.bodega, documento: x.documento, ...cerrar(x.g) })),
        pedidos: Object.fromEntries([...pedidos].map(([n, g]) => [n, { cajas: g.cajas, estibas: g.estibas.size }])),
        truncado: paginas >= MAX_PAGINAS_MOV
    };
}

async function traer(token: string, desde: string, hasta = "") {
    const [tareas, salidas, entradas] = await Promise.all([
        hasta ? traerTareasRango(token, desde, hasta) : traerTareas(token, desde),
        movimientos(token, desde, "salida", hasta),
        movimientos(token, desde, "entrada", hasta)
    ]);
    return {
        ...tareas,
        movimientos: {
            resumen: [...salidas.resumen, ...entradas.resumen],
            pedidos: salidas.pedidos,
            truncado: salidas.truncado || entradas.truncado
        }
    };
}

async function traerTareas(token: string, desde: string) {

    const filas: Record<string, unknown>[] = [];
    let total: number | null = null;
    let paginas = 0;

    for (let skip = 0; paginas < MAX_PAGINAS; skip += TOMA) {
        const p = await pagina(token, skip);
        paginas++;
        total = p.total ?? total;

        let alguna = false;
        for (const f of p.filas) {
            const cuando = fechaMasNueva(f);
            const abierta = f.ctsk_task_state !== "Complete";
            if (abierta || !cuando || cuando.slice(0, 10) >= desde) {
                if (cuando.slice(0, 10) >= desde) alguna = true;
                const fila: Record<string, unknown> = {};
                for (const c of CAMPOS) fila[c] = f[c] ?? null;
                filas.push(fila);
            }
        }

        if (p.filas.length < TOMA || !alguna) break;
    }

    return { filas, desde, consultadoEn: new Date().toISOString(), paginas, total, truncado: paginas >= MAX_PAGINAS };
}

/* RANGO CERRADO (informe mensual): las tareas TERMINADAS entre `desde`
   y `hasta`, con filtro de fecha en Iztech. Sirve para cualquier mes,
   no solo los recientes, y no trae las abiertas (no son del informe). */
async function traerTareasRango(token: string, desde: string, hasta: string) {

    const filas: Record<string, unknown>[] = [];
    let total: number | null = null;
    let paginas = 0;
    const tope = new Date(Date.parse(hasta + "T00:00:00Z") + 86400_000).toISOString().slice(0, 10);

    for (let skip = 0; paginas < MAX_PAGINAS; skip += TOMA_MOV) {
        const p = await consulta(token, VISTA, {
            take: String(TOMA_MOV), skip: String(skip), orderby: "ctsk_id desc",
            where: `"ctsk_complete_date">='${desde}' AND "ctsk_complete_date"<'${tope}'`
        });
        paginas++;
        total = p.total ?? total;
        for (const f of p.filas) {
            const fila: Record<string, unknown> = {};
            for (const c of CAMPOS) fila[c] = f[c] ?? null;
            filas.push(fila);
        }
        if (p.filas.length < TOMA_MOV) break;
    }

    return { filas, desde, hasta, consultadoEn: new Date().toISOString(), paginas, total, truncado: paginas >= MAX_PAGINAS };
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (req) => {

    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

    try {
        const token = Deno.env.get("IZTECH_TOKEN");
        if (!token) return responder({ error: "Falta el secreto IZTECH_TOKEN en Supabase." }, 500);

        // ¿Quién llama? Con su propia sesión se le pregunta a la base.
        const auth = req.headers.get("Authorization") || "";
        const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
            global: { headers: { Authorization: auth } },
            auth: { persistSession: false }
        });
        const { data: esAdmin, error: errorRol } = await supabase.rpc("es_admin");
        if (errorRol) return responder({ error: "No se pudo verificar la sesión." }, 401);
        if (esAdmin !== true) return responder({ error: "Solo el administrador puede ver el picking." }, 403);

        // `desde`: fecha fija, validada (nunca texto libre hacia Iztech).
        const url = new URL(req.url);
        let desde = url.searchParams.get("desde") || "";
        let hasta = url.searchParams.get("hasta") || "";
        if (!desde && req.method === "POST") {
            try {
                const cuerpo = await req.json();
                desde = String(cuerpo.desde || "");
                hasta = String(cuerpo.hasta || "");
            } catch { /* sin cuerpo */ }
        }
        if (!FECHA.test(desde)) {
            const d = new Date(Date.now() - 7 * 86400_000);
            desde = d.toISOString().slice(0, 10);
        }
        if (hasta && !FECHA.test(hasta)) hasta = "";

        if (hasta) {
            // Rango cerrado (informe): cualquier fecha, pero no más de MAX_DIAS de largo.
            const largo = (Date.parse(hasta + "T00:00:00Z") - Date.parse(desde + "T00:00:00Z")) / 86400_000;
            if (!(largo >= 0 && largo <= MAX_DIAS)) {
                return responder({ error: "El rango debe ir de menor a mayor y durar máximo " + MAX_DIAS + " días." }, 400);
            }
        } else {
            const dias = (Date.now() - Date.parse(desde + "T00:00:00Z")) / 86400_000;
            if (!(dias >= -1 && dias <= MAX_DIAS)) {
                return responder({ error: "El rango máximo es de " + MAX_DIAS + " días hacia atrás." }, 400);
            }
        }

        const clave = desde + "|" + hasta;
        const copia = copias.get(clave);
        if (copia && Date.now() - copia.en < COPIA_MS) return responder({ ...(copia.datos as object), deCopia: true });

        let promesa = enCurso.get(clave);
        if (!promesa) {
            promesa = traer(token, desde, hasta).finally(() => enCurso.delete(clave));
            enCurso.set(clave, promesa);
        }
        const datos = await promesa;
        copias.set(clave, { en: Date.now(), datos });
        return responder(datos);

    } catch (error) {
        console.error("[picking]", error);
        return responder({ error: "No se pudo consultar Iztech: " + (error instanceof Error ? error.message : String(error)) }, 502);
    }
});
