/* =========================================================
   INLOTRANS
   Cajas de un vehículo — lo que dicen las fichas

   Une el REGISTRO de un vehículo (su placa) con lo que Iztech sabe de
   él (ver shared/services/cajas.js): cuántas cajas y estibas lleva
   o descargó, y qué dice el plan del envío.

   Metros cúbicos: todavía no (decisión 2026-10-19). Se asignarán
   después a las cajas, y de ahí a los vehículos.
   ========================================================= */

// "SVD 390", "svd390 " y "SVD390" son la misma placa.
export const normalizarPlaca = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const miles = (n) => Math.round(Number(n) || 0).toLocaleString("es-CO");

function escapar(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/*
    Lo que se sabe de este vehículo, o null si Iztech no lo trae.
    `instantanea` es lo que entrega suscribirseACajas().
*/
export function datosCajas(registro, instantanea, exigeTipologia) {

    if (!registro || !instantanea || !instantanea.vehiculos) return { textoCajas: "", cajasIztech: null };

    // Sin tipología no se muestran las cajas: se ordena el proceso (tipología primero),
    // igual que con el avance. `exigeTipologia` es true donde la bodega tiene tipologías.
    if (exigeTipologia && !registro.tipologia) return { textoCajas: "", cajasIztech: null, faltaTipologia: true };

    const item = instantanea.vehiculos[normalizarPlaca(registro.placa)];
    if (!item || !item.actual) return { textoCajas: "", cajasIztech: null };

    const e = item.actual;
    const partes = [];

    if (e.cajas > 0) partes.push(`${miles(e.cajas)} ${e.cajas === 1 ? "caja" : "cajas"}`);
    if (e.estibas > 0) partes.push(`${miles(e.estibas)} ${e.estibas === 1 ? "estiba" : "estibas"}`);

    // Solo el plan: el vehículo viene pero todavía no hay movimientos.
    const soloPlan = partes.length === 0;
    const texto = soloPlan ? "Sin cajas movidas todavía" : partes.join(" · ");

    return {
        textoCajas: texto,
        cajasIztech: {
            cajas: e.cajas, estibas: e.estibas, otras: e.otras, tipo: e.tipo,
            vehiculoTipo: e.vehiculoTipo, categoria: e.categoria, tipoCargue: e.tipoCargue,
            conductor: e.conductor, soloPlan: soloPlan, obsoleta: !!instantanea.obsoleta
        }
    };
}

/*
    El bloque para las fichas (tarjeta del muelle y ficha del 3D). SIN
    ninguna hora que cambie sola ("hace 12 s"): ese HTML se reescribe solo
    cuando cambia, y un texto que cambia cada pocos segundos le cerraría
    el desplegable de tipología al supervisor en la cara.
*/
export function bloqueCajas(registro, instantanea, exigeTipologia) {

    const { cajasIztech: d, textoCajas, faltaTipologia } = datosCajas(registro, instantanea, exigeTipologia);

    // Hay cajas en Iztech pero falta la tipología: se dice por qué no se ven.
    if (faltaTipologia) {
        const item = instantanea && instantanea.vehiculos && instantanea.vehiculos[normalizarPlaca(registro.placa)];
        return item ? '<div class="cajas-iztech obsoleta"><i class="ti ti-lock"></i> <span>Asigna la tipología para ver las cajas</span></div>' : "";
    }

    if (!d) return "";

    const detalle = [d.tipo, d.vehiculoTipo, d.tipoCargue].filter(Boolean).map(escapar).join(" · ");
    const otras = Object.entries(d.otras || {}).map(([u, n]) => `${miles(n)} ${escapar(u)}`).join(", ");

    return '<div class="cajas-iztech' + (d.obsoleta ? " obsoleta" : "") + '">' +
               '<i class="ti ti-packages"></i> <span>' + escapar(textoCajas) + "</span>" +
               (detalle ? " <small>" + detalle + "</small>" : "") +
               (otras ? " <small>+ " + otras + "</small>" : "") +
               (d.obsoleta ? ' <small title="Iztech no respondió en la última consulta: es el último dato conocido">(último dato)</small>' : "") +
           "</div>";
}
