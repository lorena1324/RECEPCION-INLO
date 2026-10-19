/* =========================================================
   INLOTRANS
   Cliente de la API de Iztech (solo servidor)

   El token es una contraseña: vive SOLO en servidor/.env (que
   git ignora) y SOLO se usa aquí, en el servidor. El navegador
   nunca lo ve ni habla directo con Iztech: pide los datos a
   nuestra API (/api/...), que es quien consulta.

   Variables (ver servidor/.env.example):

       IZTECH_URL_BASE       dirección base de la API
       IZTECH_TOKEN          el token (nunca en código ni en git)
       IZTECH_COPIA_SEGUNDOS  cuánto vive la copia en memoria (por defecto 10 s:
                              las mediciones no pueden ir más de 30 s atrasadas
                              entre dispositivos)

   SUPUESTO POR CONFIRMAR: se asume el mismo formato que la API de
   iLogic que ya usa el proyecto MQ (encabezado `token`, respuesta
   { code, message: [filas], metadata: { resultset: { count } } }).
   Se confirma con la primera respuesta real; si el formato es
   otro, el único sitio que cambia es `filasDeRespuesta`.

   Lecciones que MQ ya pagó con iLogic y que se repiten aquí:
     - Con el token mal puesto, la API responde HTTP 200 con
       `code: 406`: mirar solo el HTTP no basta.
     - `where` se inserta directo en su SQL: solo valores fijos y
       validados (`valorSeguro`), jamás texto que venga de un usuario.
     - Por páginas el orden puede cambiar y se pierden filas: se
       exige que lleguen tantas filas como anuncia `count`.
     - Varias pantallas consultan a la vez: copia en memoria y UNA
       sola llamada en curso. Si la API falla y hay copia, se sirve
       la copia con su fecha real.
   ========================================================= */

const ESPERA_MAXIMA_MS = 60_000;
const VISTA_VALIDA = /^[A-Za-z0-9._-]{1,80}$/;
const LISTA_VALIDA = /^[A-Za-z0-9_, ]{1,400}$/;


/* ---------------------------------------------------------
   CONFIGURACIÓN
   --------------------------------------------------------- */

export function leerConfigIztech(env = process.env) {

    const base = String(env.IZTECH_URL_BASE || "").trim();
    const token = String(env.IZTECH_TOKEN || "").trim();
    const copia = Number(env.IZTECH_COPIA_SEGUNDOS);

    return {
        urlBase: base && !base.endsWith("/") ? base + "/" : base,
        token: token,
        copiaSegundos: Number.isFinite(copia) && copia >= 0 ? copia : 10,
        configurado: !!(base && token)
    };
}


/* ---------------------------------------------------------
   FILTROS SEGUROS
   --------------------------------------------------------- */

/*
    Un valor que va dentro de un `where`. La API lo mete tal cual en su
    SQL: nada de comillas ni caracteres raros. Un valor extraño detiene
    la consulta en vez de colarse.
*/
export function valorSeguro(valor) {
    const v = String(valor);
    if (!/^[A-Za-z0-9 ._-]{1,60}$/.test(v)) {
        throw new Error(`Valor no permitido para filtrar en Iztech: "${v}".`);
    }
    return `'${v}'`;
}

// "Campo" IN ('a','b'): el campo también se valida.
export function filtroEn(campo, valores) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(campo)) {
        throw new Error(`Campo no permitido para filtrar en Iztech: "${campo}".`);
    }
    return `"${campo}" IN (${valores.map(valorSeguro).join(",")})`;
}


/* ---------------------------------------------------------
   RESPUESTA
   --------------------------------------------------------- */

/*
    OJO con `count`: es el TOTAL de filas que cumplen la consulta, no las
    que se pidieron. Con `take=3` sobre 353.272 filas, count = 353272 y
    llegan 3 (verificado contra la API el 2026-10-19). Lo que se exige es
    que lleguen tantas como se podían traer: min(total - skip, take).
*/
export function filasDeRespuesta(cuerpo, { take = null, skip = 0 } = {}) {

    const r = cuerpo;
    if (!r || typeof r !== "object") throw new Error("Iztech respondió algo que no es JSON.");

    if (r.code !== 200 || !Array.isArray(r.message)) {
        const detalle = typeof r.message === "string" ? r.message : "respuesta sin filas";
        throw new Error(`Iztech rechazó la consulta (code ${String(r.code)}: ${detalle}). Revise IZTECH_TOKEN.`);
    }

    const total = Number(r.metadata && r.metadata.resultset && r.metadata.resultset.count);

    if (Number.isFinite(total)) {
        const esperadas = Math.max(0, Math.min(total - skip, take === null ? Infinity : take));
        if (r.message.length !== esperadas) {
            throw new Error(`Iztech entregó ${r.message.length} de ${esperadas} filas esperadas (total ${total}): respuesta incompleta.`);
        }
    }

    return { filas: r.message, total: Number.isFinite(total) ? total : r.message.length };
}


/* ---------------------------------------------------------
   CLIENTE
   --------------------------------------------------------- */

export class ClienteIztech {

    #config;
    #fetch;
    #ahora;
    #copias = new Map();      // consulta → { resultado, consultadoEn }
    #enCurso = new Map();     // consulta → promesa
    #ultimo = { ok: null, en: null, error: null };

    constructor(config, { fetchFn = globalThis.fetch, ahora = () => new Date() } = {}) {
        this.#config = config;
        this.#fetch = fetchFn;
        this.#ahora = ahora;
    }

    get configurado() {
        return this.#config.configurado;
    }

    /*
        Lo único que se puede enseñar de la conexión: si está configurada,
        a qué servidor (sin ruta) y cómo salió la última consulta. Nunca
        el token.
    */
    estado() {

        let servidor = null;
        try { servidor = this.#config.urlBase ? new URL(this.#config.urlBase).host : null; } catch { servidor = "(dirección inválida)"; }

        return {
            configurado: this.#config.configurado,
            servidor: servidor,
            copiaSegundos: this.#config.copiaSegundos,
            ultimaConsulta: this.#ultimo.en,
            ultimaConsultaOk: this.#ultimo.ok,
            ultimoError: this.#ultimo.error
        };
    }

    /*
        Consulta una vista. `parametros`: take, skip, orderby, select (y
        `where`, SOLO armado en el servidor con filtroEn). Devuelve
        { filas, total, consultadoEn, deCopia }.
    */
    async consultarVista(vista, parametros = {}) {

        if (!this.#config.configurado) {
            throw new Error("Iztech no está configurado (faltan IZTECH_URL_BASE e IZTECH_TOKEN en servidor/.env).");
        }
        if (!VISTA_VALIDA.test(vista)) throw new Error(`Nombre de vista no válido: "${vista}".`);

        const consulta = new URLSearchParams();
        for (const [clave, valor] of Object.entries(parametros)) {
            if (valor === undefined || valor === null || valor === "") continue;
            if ((clave === "take" || clave === "skip") && !Number.isInteger(Number(valor))) throw new Error(`"${clave}" debe ser un entero.`);
            if ((clave === "orderby" || clave === "select") && !LISTA_VALIDA.test(String(valor))) throw new Error(`"${clave}" trae caracteres no permitidos.`);
            consulta.set(clave, String(valor));
        }

        // Sin `take` la API trae pocas filas por defecto: se pide explícito, como hace MQ.
        if (!consulta.has("take")) consulta.set("take", "10000");

        const url = `${this.#config.urlBase}${vista}?${consulta.toString()}`;
        const pedido = { take: Number(consulta.get("take")), skip: Number(consulta.get("skip")) || 0 };

        const copia = this.#copias.get(url);
        const vigente = copia && this.#ahora() - copia.consultadoEn < this.#config.copiaSegundos * 1000;
        if (vigente) return { ...copia.resultado, consultadoEn: copia.consultadoEn, deCopia: true };

        // Si dos pantallas piden a la vez, sale UNA sola llamada.
        let enCurso = this.#enCurso.get(url);
        if (!enCurso) {
            enCurso = this.#traer(url, pedido).finally(() => this.#enCurso.delete(url));
            this.#enCurso.set(url, enCurso);
        }

        try {
            const resultado = await enCurso;
            const consultadoEn = this.#ahora();
            this.#copias.set(url, { resultado, consultadoEn });
            this.#ultimo = { ok: true, en: consultadoEn.toISOString(), error: null };
            return { ...resultado, consultadoEn, deCopia: false };

        } catch (error) {
            this.#ultimo = { ok: false, en: this.#ahora().toISOString(), error: error.message };
            // Con una copia vieja se sirve esa (con su fecha real) en vez de dejar la pantalla vacía.
            if (copia) return { ...copia.resultado, consultadoEn: copia.consultadoEn, deCopia: true, obsoleta: true };
            throw error;
        }
    }

    async #traer(url, pedido) {

        const respuesta = await this.#fetch(url, {
            headers: { token: this.#config.token, Accept: "application/json" },
            signal: AbortSignal.timeout(ESPERA_MAXIMA_MS)
        });

        if (!respuesta.ok) throw new Error(`Iztech respondió HTTP ${respuesta.status}.`);
        return filasDeRespuesta(await respuesta.json(), pedido);
    }
}
