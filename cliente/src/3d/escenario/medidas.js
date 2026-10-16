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

// Nave alta de estantería de 5 niveles, como la bodega de MQ
// (14 m de alto; 87 m de fondo en MQ, de los cuales 12 son la bahía
// de muelles, que aquí es el patio: quedan 75 de nave y 1 de margen).
// El fondo no afecta muelles ni patio: solo lo que se ve por dentro.
export const ALTO_MURO = 14;
export const FONDO_BODEGA = 76;

export const Z_MUELLE = 0.3;    // la puerta trasera del vehículo
export const Z_CARRIL = 21;
// Donde se pinta la ficha del vehículo: entre su frente (una
// tractomula llega a z ≈ 15,7) y la línea de pare (z = 23).
export const Z_FICHA = 19.4;
// La cola de los vehículos estacionados. Lejos del carril a
// propósito: una tractomula (15,4 m) parada en el carril no alcanza
// a meterse en la fila de cupos.
export const Z_PATIO = 38;
export const LARGO_CUPO = 17;   // cabe una tractomula

export const SEPARACION_PATIO = 4.4;

// M1 queda a la DERECHA de quien mira la fachada desde el patio, como
// en la bodega real (el índice crece hacia -x).
export function xDeMuelle(indice, total) {
    return ((total - 1) / 2 - indice) * MUELLE.separacion;
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
