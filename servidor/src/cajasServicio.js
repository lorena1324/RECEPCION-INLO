/* =========================================================
   INLOTRANS
   Servicio de cajas por vehículo: consulta a Iztech cada pocos
   segundos y avisa cuando algo cambió

   REQUISITO: las mediciones no pueden ir más de 30 segundos
   atrasadas entre dispositivos. Por eso:

     - UN solo lugar consulta a Iztech (aquí), cada
       IZTECH_REFRESCO_SEGUNDOS (15 por defecto), no cada pantalla.
     - Cuando el resultado cambia se EMPUJA a todos los equipos
       conectados (Socket.IO): nadie tiene que esperar su turno de
       consulta. Los que no tengan el socket consultan la copia de
       esta misma instantánea cada ~10 s.
     - El peor caso desde que Iztech registra un dato hasta que lo
       ve una pantalla es el intervalo (15 s) + lo que tarde Iztech
       en responder (0,2–4 s) + el empuje (<1 s): ~20 s.

   Lo que NO controlamos es cuánto tarda el propio Iztech en
   registrar el dato en sus vistas (hoy se ven filas de ~1 minuto de
   antigüedad). El 30 s se mide desde que el dato está en Iztech.

   Si una consulta falla se conserva la última instantánea, marcada
   como obsoleta y con su hora real: preferible a una pantalla vacía.
   ========================================================= */

import { agruparCajas } from "./cajas.js";
import { filtroEn } from "./iztech.js";

const VISTA = (nombre) => `User.BI.${nombre}.List.View1`;

// Solo lo que hace falta: la fila completa pesa varias veces más.
const COLUMNAS_MOVIMIENTO = "Id,TransactionDate,CreatedOn,WarehouseCode,PrimaryQty,PrimaryUomCode,Vehicle,ShipmentNumber,HandlingUnit";

export function leerConfigCajas(env = process.env) {

    const numero = (v, porDefecto) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : porDefecto; };

    return {
        intervaloSegundos: numero(env.IZTECH_REFRESCO_SEGUNDOS, 15),
        ventanaDias: numero(env.IZTECH_VENTANA_DIAS, 2),
        almacenes: String(env.IZTECH_ALMACENES || "J3,J4,B9").split(",").map((v) => v.trim()).filter(Boolean)
    };
}

// El día en Bogotá, no en UTC: a las 8 p. m. ya es "mañana" para el servidor.
export function diaBogota(fecha) {
    return fecha.toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}

export class ServicioCajas {

    #cliente; #config; #ahora; #opciones;
    #instantanea = null;
    #huella = "";
    #oyentes = new Set();
    #temporizador = null;
    #enCurso = false;
    #estado = { ok: null, en: null, duracionMs: null, error: null, filas: null };

    constructor(cliente, config = leerConfigCajas(), { ahora = () => new Date(), categorias = {} } = {}) {
        this.#cliente = cliente;
        this.#config = config;
        this.#ahora = ahora;
        this.#opciones = categorias;
    }

    /*
        Avisa después de CADA refresco bueno, diciendo si hubo cambio:
        `fn(cambio)`. Con cambio se empuja la información completa; sin
        él, solo un latido con la hora (para que las pantallas sepan que
        el dato está al día aunque no haya novedades). Devuelve cómo
        dejar de escuchar.
    */
    alCambiar(fn) {
        this.#oyentes.add(fn);
        return () => this.#oyentes.delete(fn);
    }

    iniciar() {
        if (!this.#cliente.configurado || this.#temporizador) return;
        this.refrescar();
        this.#temporizador = setInterval(() => this.refrescar(), this.#config.intervaloSegundos * 1000);
        this.#temporizador.unref();
    }

    detener() {
        clearInterval(this.#temporizador);
        this.#temporizador = null;
    }

    estado() {
        return {
            ...this.#estado,
            intervaloSegundos: this.#config.intervaloSegundos,
            ventanaDias: this.#config.ventanaDias,
            generadoEn: this.#instantanea ? this.#instantanea.generadoEn : null,
            vehiculos: this.#instantanea ? Object.keys(this.#instantanea.porPlaca).length : 0
        };
    }

    /*
        Lo que ve una sesión de esa operación: los vehículos con
        movimientos en su almacén y los que solo están planeados (sin
        movimientos todavía, no se sabe a qué almacén irán).
    */
    paraOperacion(operacion) {

        if (!this.#instantanea) return { generadoEn: null, obsoleta: false, vehiculos: {} };

        const vehiculos = {};
        for (const [placa, item] of Object.entries(this.#instantanea.porPlaca)) {
            if (item.operacion === operacion || item.operacion === "") vehiculos[placa] = item;
        }

        return { generadoEn: this.#instantanea.generadoEn, obsoleta: this.#estado.ok === false, vehiculos };
    }

    async refrescar() {

        if (this.#enCurso) return;     // si la anterior no terminó, se salta: no se amontonan
        this.#enCurso = true;

        const inicio = Date.now();

        try {
            const desde = diaBogota(new Date(this.#ahora().getTime() - this.#config.ventanaDias * 864e5));
            const donde = `"TransactionDate">='${desde}' AND ${filtroEn("WarehouseCode", this.#config.almacenes)}`;

            const [envios, salidas, entradas] = await Promise.all([
                this.#cliente.consultarVista(VISTA("Shipments"), { orderby: "Id desc", where: `"ModifiedOn">='${desde}'` }),
                this.#cliente.consultarVista(VISTA("OutboundTransactions"), { orderby: "Id desc", where: donde, select: COLUMNAS_MOVIMIENTO }),
                this.#cliente.consultarVista(VISTA("InboundTransactions"), { orderby: "Id desc", where: donde, select: COLUMNAS_MOVIMIENTO })
            ]);

            const porPlaca = agruparCajas({ envios: envios.filas, salidas: salidas.filas, entradas: entradas.filas }, this.#opciones);
            const huella = JSON.stringify(porPlaca);

            this.#instantanea = { generadoEn: this.#ahora().toISOString(), desde, porPlaca };
            this.#estado = {
                ok: true, en: this.#instantanea.generadoEn, duracionMs: Date.now() - inicio, error: null,
                filas: { envios: envios.filas.length, salidas: salidas.filas.length, entradas: entradas.filas.length }
            };

            const cambio = huella !== this.#huella;
            this.#huella = huella;
            for (const fn of this.#oyentes) { try { fn(cambio); } catch (e) { console.error("[cajas] oyente falló:", e.message); } }

        } catch (error) {
            this.#estado = { ...this.#estado, ok: false, en: this.#ahora().toISOString(), duracionMs: Date.now() - inicio, error: error.message };
            console.error("[cajas] no se pudo refrescar:", error.message);

        } finally {
            this.#enCurso = false;
        }
    }
}
