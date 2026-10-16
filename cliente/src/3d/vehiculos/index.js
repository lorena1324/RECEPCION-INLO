/* =========================================================
   INLOTRANS
   Fábrica de modelos 3D

   La tipología guarda una clave (`modelo3d`, ver
   compartido/dominio/Tipologia.js) y aquí se traduce a la clase.
   Agregar una carrocería nueva es: crear la subclase, ponerla en
   este mapa, en MODELOS_3D (compartido/dominio/Tipologia.js) y en
   el MODELOS_3D de shared/services/config.js (el que lee el
   panel de administración).
   ========================================================= */

import { MODELO_3D_POR_DEFECTO } from "@inlotrans/compartido/dominio";

import * as carrocerias from "./carrocerias.js";

const {
    Van, Nhr, Turbo, Sencillo, DobleTroque, Refrigerado, Estacas, Lona,
    MiniMula, TractomulaFurgon, Tractomula, TractomulaRefrigerada, TractomulaLona, TractomulaPlataforma,
    SemirremolqueSinCabezote, ContenedorSinCabezote
} = carrocerias;

const CLASES = {
    van: Van,
    nhr: Nhr,
    turbo: Turbo,
    sencillo: Sencillo,
    dobleTroque: DobleTroque,
    refrigerado: Refrigerado,
    estacas: Estacas,
    lona: Lona,
    miniMula: MiniMula,
    tractomulaFurgon: TractomulaFurgon,
    tractomula: Tractomula,
    tractomulaRefrigerada: TractomulaRefrigerada,
    tractomulaLona: TractomulaLona,
    tractomulaPlataforma: TractomulaPlataforma,
    semirremolque: SemirremolqueSinCabezote,
    contenedorSinCabezote: ContenedorSinCabezote
};

// opciones: { semilla, rotulo } — ver el constructor de ModeloVehiculo.
export function crearModelo(clave, opciones) {
    const Clase = CLASES[clave] || CLASES[MODELO_3D_POR_DEFECTO];
    return new Clase(opciones);
}

export { ModeloVehiculo } from "./ModeloVehiculo.js";
export { CLASES };
