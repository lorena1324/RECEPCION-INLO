/* =========================================================
   INLOTRANS
   Función de Supabase: picking (tareas del WMS de Iztech)

   El token de Iztech es una contraseña: vive SOLO aquí, como
   secreto de Supabase (IZTECH_TOKEN). El navegador nunca lo ve: el
   panel del administrador llama a esta función con su sesión y la
   función consulta Iztech.

   Quién puede: solo el ADMINISTRADOR (se le pregunta a la base con
   public.es_admin(), con la sesión de quien llama).

   GET/POST  /functions/v1/picking?desde=2026-11-01
       → { filas: [...], desde, consultadoEn, paginas, total }

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
    "ctsk_complete_date", "ctti_time_els_value", "ctsk_organization_id", "crul_name"
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
    const q = new URLSearchParams({ take: String(TOMA), skip: String(skip), orderby: "ctsk_id desc" });
    const r = await fetch(URL_BASE + VISTA + "?" + q.toString(), {
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

async function traer(token: string, desde: string) {

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
        if (!desde && req.method === "POST") {
            try { desde = String((await req.json()).desde || ""); } catch { /* sin cuerpo */ }
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
            const d = new Date(Date.now() - 7 * 86400_000);
            desde = d.toISOString().slice(0, 10);
        }
        const dias = (Date.now() - Date.parse(desde + "T00:00:00Z")) / 86400_000;
        if (!(dias >= -1 && dias <= MAX_DIAS)) {
            return responder({ error: "El rango máximo es de " + MAX_DIAS + " días hacia atrás." }, 400);
        }

        const copia = copias.get(desde);
        if (copia && Date.now() - copia.en < COPIA_MS) return responder({ ...(copia.datos as object), deCopia: true });

        let promesa = enCurso.get(desde);
        if (!promesa) {
            promesa = traer(token, desde).finally(() => enCurso.delete(desde));
            enCurso.set(desde, promesa);
        }
        const datos = await promesa;
        copias.set(desde, { en: Date.now(), datos });
        return responder(datos);

    } catch (error) {
        console.error("[picking]", error);
        return responder({ error: "No se pudo consultar Iztech: " + (error instanceof Error ? error.message : String(error)) }, 502);
    }
});
