/* =========================================================
   INLOTRANS
   Medidas del escenario (metros)

   La cara exterior del muro de muelles está en z = 0; la bodega
   queda hacia -z y el patio hacia +z:

       z = 0          muro de muelles (los vehículos, en reversa)
       z = Z_CARRIL   carril de maniobra: por aquí entran, cambian
                      de muelle y salen
       z = Z_PATIO    fila de cupos del patio (esperando muelle)

   Se entra por la derecha (+x) y se sale por la izquierda (-x).
   ========================================================= */

export const MUELLE = {
    separacion: 5.6,
    anchoPuerta: 3.0,
    altoPuerta: 3.2,
    alturaAnden: 1.25   // piso interior = altura del piso del furgón
};

export const ALTO_MURO = 8.6;
export const FONDO_BODEGA = 28;

export const Z_MUELLE = 0.3;    // la puerta trasera del vehículo
export const Z_CARRIL = 21;
// La cola de los vehículos estacionados. Lejos del carril a
// propósito: una tractomula (15,4 m) parada en el carril no alcanza
// a meterse en la fila de cupos.
export const Z_PATIO = 38;
export const LARGO_CUPO = 17;   // cabe una tractomula

export const SEPARACION_PATIO = 4.4;

export function xDeMuelle(indice, total) {
    return (indice - (total - 1) / 2) * MUELLE.separacion;
}

export function anchoBodega(total) {
    return total * MUELLE.separacion + 16;
}

// El patio es un poco más ancho que la bodega.
export function cuposPatio(total) {
    return Math.max(4, Math.floor((anchoBodega(total) + 12) / SEPARACION_PATIO));
}

export function xDeCupo(cupo, total) {
    return (cupo - (cuposPatio(total) - 1) / 2) * SEPARACION_PATIO;
}

export function xEntrada(total) {
    return anchoBodega(total) / 2 + 30;
}

export function xSalida(total) {
    return -(anchoBodega(total) / 2 + 30);
}
