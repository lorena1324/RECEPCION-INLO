/* =========================================================
   INLOTRANS
   Fábrica de modelos 3D

   La tipología guarda una clave (`modelo3d`, ver
   compartido/dominio/Tipologia.js) y aquí se traduce a la clase.
   Agregar una carrocería nueva es: crear la subclase, ponerla en
   este mapa y en MODELOS_3D.
   ========================================================= */

import { MODELO_3D_POR_DEFECTO } from "@inlotrans/compartido/dominio";

import { Turbo, Sencillo, DobleTroque, Tractomula } from "./carrocerias.js";

const CLASES = {
    turbo: Turbo,
    sencillo: Sencillo,
    dobleTroque: DobleTroque,
    tractomula: Tractomula
};

// opciones: { semilla } — ver el constructor de ModeloVehiculo.
export function crearModelo(clave, opciones) {
    const Clase = CLASES[clave] || CLASES[MODELO_3D_POR_DEFECTO];
    return new Clase(opciones);
}

export { ModeloVehiculo } from "./ModeloVehiculo.js";
export { Turbo, Sencillo, DobleTroque, Tractomula };
