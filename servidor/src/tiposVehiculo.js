/* =========================================================
   INLOTRANS
   Tipos de vehículo de Iztech ↔ categorías de INLOTRANS

   Iztech (iLogic) trae `VehicleType` en el plan de cada envío:
   SENCILLO, MULA, MULA 40, MULA 20, MINI MULA, TURBO. Las
   categorías de INLOTRANS son las claves de MODELOS_3D
   (compartido/dominio/Tipologia.js).

   DECISIÓN (2026-10-19): el SENCILLO y la MULA 20 se unifican en una
   sola categoría, el sencillo. La categoría "mula20" se conserva POR
   ACTIVAR: nunca se sabe si hay que separarlas otra vez. Encenderla
   es una sola variable (IZTECH_MULA20_ACTIVA=true en servidor/.env),
   sin tocar código.

   Esto solo CLASIFICA lo que dice iLogic: no cambia la tipología que
   el supervisor asigna al vehículo, que sigue siendo suya.
   ========================================================= */

// Sin tildes, mayúsculas y espacios simples: "Mula  20 " → "MULA 20".
const limpiar = (v) => String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

// Categoría de INLOTRANS por cada tipo de iLogic.
const TABLA = {
    "SENCILLO": "sencillo",
    "MULA 20": "mula20",          // por activar: mientras no lo esté, se trata como sencillo
    "MULA": "tractomula",
    "MULA 40": "tractomula",
    "MINI MULA": "miniMula",
    "TURBO": "turbo"
};

export function leerMula20Activa(env = process.env) {
    return String(env.IZTECH_MULA20_ACTIVA || "").trim().toLowerCase() === "true";
}

/*
    Categoría de INLOTRANS para un `VehicleType` de iLogic, o null si no
    se reconoce (un tipo nuevo de iLogic no se adivina: se deja sin
    categoría y se nota, en vez de pintarlo como otra cosa).
*/
export function categoriaDeVehiculo(tipoILogic, { mula20Activa = leerMula20Activa() } = {}) {

    const categoria = TABLA[limpiar(tipoILogic)];
    if (!categoria) return null;

    return categoria === "mula20" && !mula20Activa ? "sencillo" : categoria;
}
