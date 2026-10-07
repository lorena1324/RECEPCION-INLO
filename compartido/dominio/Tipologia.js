/* =========================================================
   INLOTRANS
   Tipología de vehículo

   Las tipologías NO son clases: las crea el administrador en
   cada bodega (nombre + metas de tiempo), así que son datos.
   Lo que sí es código es la FORMA del vehículo en 3D —un
   número cerrado de carrocerías— y cada tipología dice cuál
   usa en `modelo3d`. Así el administrador puede crear
   "Mula refrigerada" o "Turbo J3" sin que haya que programar
   nada: solo escoge con qué carrocería se dibuja.
   ========================================================= */

export const TIPOS_OPERACION = ["Cargue", "Descargue", "Ambos"];

export const MODALIDADES = ["Arrumado", "Paletizado"];
export const MODALIDAD_POR_DEFECTO = "Arrumado";

// Al doble de la meta empieza el rojo (ver config.js de la app
// actual: misma regla que la espera en patio).
export const MULTIPLICADOR_URGENTE = 2;

// Carrocerías que existen en 3D. La clave es lo que se guarda en
// la tipología; la clase vive en el cliente (3d/vehiculos).
export const MODELOS_3D = {
    turbo: "Turbo",
    sencillo: "Sencillo",
    dobleTroque: "Doble troque",
    tractomula: "Tractomula"
};

export const MODELO_3D_POR_DEFECTO = "sencillo";

function numero(valor) {
    const n = Number(valor);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

export class Tipologia {

    constructor({ id, nombre = "", tiempos = {}, modelo3d } = {}) {

        this.id = id;
        this.nombre = String(nombre);
        this.modelo3d = modelo3d in MODELOS_3D ? modelo3d : MODELO_3D_POR_DEFECTO;

        // Solo la meta: los umbrales son derivados (ver umbrales()).
        this.tiempos = Object.fromEntries(
            TIPOS_OPERACION.map((op) => [op, {
                meta: numero(tiempos[op]?.meta),
                metaPaletizado: numero(tiempos[op]?.metaPaletizado)
            }])
        );
    }

    /*
        Minutos que debería tardar en muelle. `metaPaletizado` en
        cero significa "no llega paletizada" y se mide contra la
        meta normal.
    */
    metaPara(tipoOperacion, modalidad = MODALIDAD_POR_DEFECTO) {

        const t = this.tiempos[tipoOperacion];
        if (!t) return null;

        if (modalidad === "Paletizado" && t.metaPaletizado > 0) return t.metaPaletizado;
        return t.meta || null;
    }

    umbrales(tipoOperacion, modalidad) {

        const meta = this.metaPara(tipoOperacion, modalidad);
        if (meta == null) return null;

        return { meta, atencion: meta, urgente: meta * MULTIPLICADOR_URGENTE };
    }
}
