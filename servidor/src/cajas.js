/* =========================================================
   INLOTRANS
   Cajas y estibas por vehículo (a partir de las vistas de Iztech)

   Lo que se cuenta, por placa:

       cajas     la suma de PrimaryQty de las filas en CARTON
       estibas   cuántas unidades de manejo distintas (HandlingUnit)
       otras     lo que no viene en cajas (UND, M…), aparte, sin
                 mezclarlo con las cajas

   Salidas (OutboundTransactions) son lo CARGADO; entradas
   (InboundTransactions) lo DESCARGADO. El plan del envío (Shipments)
   dice qué tipo de vehículo es, el conductor, ARRUMADO/PALETIZADO y si
   es Entrada o Salida.

   Metros cúbicos: NO se calculan todavía (decisión 2026-10-19). Se
   asignarán después a las cajas, y de ahí a los vehículos.

   La llave es la PLACA normalizada: iLogic la trae sin espacio y a
   veces con uno al final ("WNZ001 "); INLOTRANS las digita como "SVD 390".
   `ShipmentNumber` de las transacciones es el `Id` del envío.
   ========================================================= */

import { categoriaDeVehiculo } from "./tiposVehiculo.js";

export const normalizarPlaca = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const CAJA = "CARTON";

function nuevoConteo() {
    return { cajas: 0, estibas: new Set(), otras: {}, filas: 0, ultima: "" };
}

function sumar(conteo, fila) {

    const cantidad = Number(fila.PrimaryQty);
    if (!Number.isFinite(cantidad)) return;

    conteo.filas++;

    if (fila.PrimaryUomCode === CAJA) conteo.cajas += cantidad;
    else conteo.otras[fila.PrimaryUomCode || "?"] = (conteo.otras[fila.PrimaryUomCode || "?"] || 0) + cantidad;

    if (fila.HandlingUnit) conteo.estibas.add(String(fila.HandlingUnit));

    const cuando = String(fila.CreatedOn || fila.TransactionDate || "");
    if (cuando > conteo.ultima) conteo.ultima = cuando;
}

/*
    Agrupa las filas por (placa, envío). Cada grupo es un ENVÍO de un
    vehículo; un vehículo puede tener varios en la ventana.

    `envios`   filas de Shipments        (plan)
    `salidas`  filas de OutboundTransactions
    `entradas` filas de InboundTransactions
*/
export function agruparCajas({ envios = [], salidas = [], entradas = [] }, opciones = {}) {

    const plan = new Map(envios.map((e) => [String(e.Id), e]));
    const grupos = new Map();   // clave → { placa, envioId, operacion, salida, entrada }

    const clave = (placa, envioId) => `${placa}|${envioId ?? ""}`;

    function grupo(fila) {
        const placa = normalizarPlaca(fila.Vehicle);
        if (!placa) return null;                       // movimientos sin vehículo (ajustes) no cuentan
        const envioId = fila.ShipmentNumber != null ? String(fila.ShipmentNumber) : null;
        const k = clave(placa, envioId);
        if (!grupos.has(k)) grupos.set(k, { placa, envioId, operacion: String(fila.WarehouseCode || ""), salida: nuevoConteo(), entrada: nuevoConteo() });
        return grupos.get(k);
    }

    for (const f of salidas) { const g = grupo(f); if (g) sumar(g.salida, f); }
    for (const f of entradas) { const g = grupo(f); if (g) sumar(g.entrada, f); }

    // Un envío planeado que todavía no movió nada también cuenta: el vehículo ya viene.
    for (const e of envios) {
        const placa = normalizarPlaca(e.VehicleCode);
        if (!placa) continue;
        const k = clave(placa, String(e.Id));
        if (!grupos.has(k)) grupos.set(k, { placa, envioId: String(e.Id), operacion: "", salida: nuevoConteo(), entrada: nuevoConteo() });
    }

    const porPlaca = {};

    for (const g of grupos.values()) {

        const e = g.envioId ? plan.get(g.envioId) : null;
        const esEntrada = e ? e.ShipmentType === "Entrada" : g.entrada.filas > g.salida.filas;
        const c = esEntrada ? g.entrada : g.salida;

        const envio = {
            id: g.envioId,
            documento: e ? e.DocNum : null,
            tipo: e ? e.ShipmentType : (esEntrada ? "Entrada" : "Salida"),
            vehiculoTipo: e ? e.VehicleType || null : null,
            categoria: e ? categoriaDeVehiculo(e.VehicleType, opciones) : null,
            tipoCargue: e ? e.TipoCargue || null : null,
            conductor: e ? String(e.TruckDriverName || "").trim() || null : null,
            transportista: e ? e.CarrierName || null : null,
            ruta: e ? e.ShipmentRoute || null : null,
            cajas: c.cajas,
            estibas: c.estibas.size,
            otras: c.otras,
            movimientos: c.filas,
            ultimaActividad: c.ultima || (e ? e.ModifiedOn || null : null)
        };

        const item = (porPlaca[g.placa] ??= { placa: g.placa, operacion: g.operacion, envios: [] });
        if (!item.operacion && g.operacion) item.operacion = g.operacion;
        item.envios.push(envio);
    }

    // El envío más reciente de cada placa es "el actual".
    for (const item of Object.values(porPlaca)) {
        item.envios.sort((a, b) => String(b.ultimaActividad || "").localeCompare(String(a.ultimaActividad || "")));
        item.actual = item.envios[0];
    }

    return porPlaca;
}

/* Un número con separador de miles en español: 1851 → "1.851". */
export const miles = (n) => Math.round(n).toLocaleString("es-CO");
