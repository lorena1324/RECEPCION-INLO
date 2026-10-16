/* =========================================================
   INLOTRANS
   Contenedor sin cabezote — lo que ve y toca cada panel

   Un articulado puede dejar el contenedor en el muelle y llevarse
   el cabezote. Este módulo es lo único que los paneles necesitan
   para ofrecerlo:

     bloqueSinCabezote(r, config, { editable })
         el HTML del bloque (estado, reloj contra la meta y el
         botón). Va en el hueco `extras` de la tarjeta del muelle.
         Sin `editable` (el cliente) solo muestra el estado.

     alClicSinCabezote(evento, operador, alTerminar)
         el manejador del clic; devuelve true si el clic era suyo.

     datosSinCabezote(r, config)
         lo que el tablero 3D necesita para dibujar solo el
         contenedor y rotular el reloj.

   El estado vive en el registro (`sinCabezote`) y cada cambio queda
   en su historial: de ahí sale el tiempo (getTiempoSinCabezote).
   ========================================================= */

import { esDesprendible, umbralesSinCabezote } from "../services/config.js";
import { getTiempoSinCabezote, nivelContraMeta } from "../services/eventos.js";
import { marcarSinCabezote } from "../services/vehiculos.js";
import { formatDuration } from "../utils/tiempos.js";

function escapar(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}

/* ¿Se puede marcar este vehículo? Articulado con tipología, activo y
   en muelle — o ya marcado, para poder deshacerlo aunque cambien la
   tipología después. */
export function puedeMarcarSinCabezote(r, config) {
    if (!r || r.horaSalida) return false;
    if (r.sinCabezote) return true;
    return r.ubicacion === "Muelle" && esDesprendible(config, r);
}

/*
    Lo que dice el reloj: cuánto lleva sin cabezote y contra qué meta.
    `nivel` es el mismo de siempre ('normal' | 'media' | 'alta'); sin
    meta configurada queda en 'normal' y el texto no menciona meta.
*/
export function estadoSinCabezote(r, config) {

    const t = getTiempoSinCabezote(r);
    const u = umbralesSinCabezote(config);
    const nivel = r.sinCabezote && u.meta ? nivelContraMeta(t.minutos, u) : "normal";

    let texto = formatDuration(t.minutos);
    if (u.meta) {
        texto += " de " + formatDuration(u.meta);
        if (nivel !== "normal") texto += " · " + formatDuration(t.minutos - u.meta) + " por encima";
    }

    return { minutos: t.minutos, nivel: nivel, texto: texto, meta: u.meta, veces: t.veces };
}

export function bloqueSinCabezote(r, config, opciones) {

    if (!puedeMarcarSinCabezote(r, config)) return "";

    const editable = !!(opciones && opciones.editable);
    const sin = !!r.sinCabezote;
    const e = estadoSinCabezote(r, config);

    const reloj = sin
        ? '<div class="muelle-meta ' + e.nivel + '"><i class="ti ti-truck-loading"></i> Sin cabezote ' + escapar(e.texto) + "</div>"
        : (e.veces
            ? '<div class="muelle-meta sin-meta"><i class="ti ti-history"></i> Ya estuvo sin cabezote ' + e.veces + (e.veces === 1 ? " vez" : " veces") + " · acumulado " + escapar(formatDuration(e.minutos)) + "</div>"
            : "");

    // El cliente solo mira: sin botón, y si no hay nada que decir, nada.
    if (!editable) return reloj;

    const boton = sin
        ? '<button class="btn btn-sm btn-primary" data-sin-cabezote="' + escapar(r.id) + ':0"><i class="ti ti-plug-connected"></i> Cabezote acoplado</button>'
        : '<button class="btn btn-sm" data-sin-cabezote="' + escapar(r.id) + ':1"><i class="ti ti-plug-connected-x"></i> Retirar cabezote</button>';

    return '<div class="avance-selector">' +
               '<span class="avance-label">Contenedor sin cabezote</span>' +
               '<div class="avance-selector-btns">' + boton + "</div>" +
               reloj +
           "</div>";
}

/*
    Manejador de clic para la delegación de eventos de cada panel.
    `alTerminar` se llama después de guardar, para repintar donde haga
    falta (el modal de novedades, por ejemplo).
*/
export function alClicSinCabezote(evento, operador, alTerminar) {

    const boton = evento.target.closest && evento.target.closest("[data-sin-cabezote]");
    if (!boton) return false;

    const partes = boton.getAttribute("data-sin-cabezote").split(":");
    const id = partes[0];
    const sin = partes[1] === "1";

    boton.disabled = true;
    marcarSinCabezote(id, sin, operador)
        .then(function () { if (alTerminar) alTerminar(id); })
        .catch(function (error) {
            console.error("No se pudo marcar el contenedor sin cabezote:", error);
            alert("No se pudo guardar el cambio. Revisa tu conexión e inténtalo de nuevo.");
            boton.disabled = false;
        });

    return true;
}

/* Lo que lee el motor 3D. */
export function datosSinCabezote(r, config) {

    // Solo se dibuja sin cabezote si de verdad se puede: un registro con
    // la marca pero sin tipología articulada se queda como camión entero.
    const desprendible = esDesprendible(config, r);
    const sin = !!r.sinCabezote && desprendible && !r.horaSalida;
    const e = estadoSinCabezote(r, config);

    return {
        sinCabezote: sin,
        minutosSinCabezote: sin ? e.minutos : 0,
        nivelSinCabezote: sin ? e.nivel : "normal",
        textoSinCabezote: sin ? e.texto : ""
    };
}
