/* =========================================================
   INLOTRANS
   La tipología del vehículo — la asigna RECEPCIÓN

   En todas las bodegas la tipología la elige el rol `recepcion`
   (y el administrador). Ni el operario, ni el supervisor, ni
   facturación: la base de datos aplica la misma regla (ver
   puede_escribir en supabase/esquema.sql).

   De ella cuelgan la tarifa y las metas de tiempo, y sin ella el
   vehículo NO PUEDE SALIR (diagnosticoSalida en vehiculos.js).

     puedeAsignarTipologia(perfil)
         ¿este usuario la puede asignar?

     selectorTipologia(r, config)
         el desplegable para la tarjeta del muelle o la ficha del
         patio. Si falta, se pone en rojo y lo dice.

     opcionesFormulario(config, elegida)
         las <option> del desplegable del formulario de entrada.

     alCambiarTipologia(evento, config, perfil, avisar)
         el manejador del cambio; devuelve true si el evento era suyo.
   ========================================================= */

import { buscarTipologia } from "../services/config.js";
import { actualizarTipologia } from "../services/vehiculos.js";

function escapar(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}

function tipologias(config) {
    return (config && config.tipologias) || [];
}

export function puedeAsignarTipologia(perfil) {
    const rol = perfil && perfil.rol;
    return rol === "recepcion" || rol === "administrador";
}

export function opcionesFormulario(config, elegida) {
    return ['<option value="">Sin asignar</option>']
        .concat(tipologias(config).map(function (t) {
            return '<option value="' + escapar(t.id) + '"' + (t.id === elegida ? " selected" : "") + ">" + escapar(t.nombre) + "</option>";
        }))
        .join("");
}

export function selectorTipologia(r, config) {

    if (!r || r.horaSalida) return "";
    if (!tipologias(config).length) return "";

    const falta = !r.tipologia;

    return '<div class="tm-clasificar' + (falta ? " falta" : "") + '">' +
               "<label>" + (falta ? "Falta la tipología — no puede salir" : "Tipología") + "</label>" +
               '<select data-set-tipologia="' + escapar(r.id) + '">' + opcionesFormulario(config, r.tipologia) + "</select>" +
           "</div>";
}

/* ── FORMULARIO DE ENTRADA ───────────────────────────────
   Recepción ve el desplegable (#grupo-tipologia); los demás, el
   aviso de que la asigna recepción (#aviso-tipologia). Se vuelve a
   pintar cada vez que llega la configuración, conservando lo
   elegido. */
export function pintarFormularioTipologia(config, perfil) {

    const grupo = document.getElementById("grupo-tipologia");
    const aviso = document.getElementById("aviso-tipologia");
    const sel = document.getElementById("f-tipologia");
    if (!grupo || !sel) return;

    const ver = puedeAsignarTipologia(perfil) && tipologias(config).length > 0;
    grupo.style.display = ver ? "" : "none";
    if (aviso) aviso.style.display = ver || !tipologias(config).length ? "none" : "";

    if (ver) sel.innerHTML = opcionesFormulario(config, sel.value);
}

// Lo que el formulario manda al crear el registro.
export function tipologiaDelFormulario(config, perfil) {
    const sel = document.getElementById("f-tipologia");
    const t = puedeAsignarTipologia(perfil) && sel ? buscarTipologia(config, sel.value) : null;
    return { tipologia: t ? t.id : "", tipologiaNombre: t ? t.nombre : "" };
}

export function limpiarFormularioTipologia() {
    const sel = document.getElementById("f-tipologia");
    if (sel) sel.value = "";
}

/* `avisar(texto, tipo)` es el toast de cada panel. */
export function alCambiarTipologia(evento, config, perfil, avisar) {

    const sel = evento.target && evento.target.closest && evento.target.closest("[data-set-tipologia]");
    if (!sel) return false;

    if (!puedeAsignarTipologia(perfil)) return true;

    const tipologia = buscarTipologia(config, sel.value);
    sel.disabled = true;

    actualizarTipologia(sel.getAttribute("data-set-tipologia"), tipologia, (perfil && perfil.nombre) || "")
        .then(function () {
            avisar(tipologia ? "Tipología asignada: " + tipologia.nombre : "Tipología retirada", "green");
        })
        .catch(function (error) {
            console.error("No se pudo guardar la tipología:", error);
            avisar(error && error.code === "permission-denied"
                ? "Solo recepción puede asignar la tipología"
                : "No se pudo guardar la tipología", "red");
        })
        .finally(function () { sel.disabled = false; });

    return true;
}
