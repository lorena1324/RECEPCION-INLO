/* =========================================================
   INLOTRANS
   Alerta de rechazo por integridad

   Cuando el sistema rechaza algo porque no se puede guardar así (placa
   repetida, salida ya registrada, avance pisado o cargado de golpe) no
   alcanza con un aviso discreto de los que desaparecen solos: el
   operario sigue con lo suyo y el rechazo pasa inadvertido.

   Esta alerta:
     - se queda en pantalla hasta que la persona la lea y la cierre,
     - suena (un tono corto de alarma, hecho con WebAudio: sin archivos),
     - explica QUÉ pasó y qué hacer.

   EL TEXTO ES PROVISIONAL (el usuario lo define después): todos los
   mensajes salen de integridad.js. Aquí solo se muestran.

   Uso, en el `catch` de cualquier acción de guardado:

       } catch (error) {
           if (mostrarRechazo(error)) return;     // ya se avisó
           ...manejo normal de errores de red...
       }

   Los navegadores solo dejan sonar si hubo un gesto del usuario en la
   página; el guardado siempre sale de un clic o de Enter, así que no
   es problema. Sin sonido disponible, la alerta visual funciona igual.
   ========================================================= */

import { esErrorIntegridad } from "../services/integridad.js";

const ID = "alerta-integridad";

// Tono de alarma corto: dos notas alternadas.
function sonar() {
    try {
        const Contexto = window.AudioContext || window.webkitAudioContext;
        if (!Contexto) return;

        const ctx = new Contexto();
        const notas = [880, 620, 880, 620];
        const paso = 0.16;

        notas.forEach((hz, i) => {
            const osc = ctx.createOscillator();
            const ganancia = ctx.createGain();
            osc.type = "square";
            osc.frequency.value = hz;
            ganancia.gain.setValueAtTime(0.0001, ctx.currentTime + i * paso);
            ganancia.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + i * paso + 0.02);
            ganancia.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (i + 1) * paso);
            osc.connect(ganancia).connect(ctx.destination);
            osc.start(ctx.currentTime + i * paso);
            osc.stop(ctx.currentTime + (i + 1) * paso);
        });

        setTimeout(() => ctx.close && ctx.close(), notas.length * paso * 1000 + 300);
    } catch (e) { /* sin audio: queda la alerta visual */ }
}

function escapar(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const TITULOS = {
    PLACA_DUPLICADA: "Esa placa ya está registrada",
    YA_SALIO: "Este vehículo ya salió",
    AVANCE_CAMBIO: "Otro usuario ya cambió este avance",
    AVANCE_SALTO: "No puedes cargar el avance así",
    AVANCE_TANDA: "Estás cargando el avance demasiado rápido",
    SIN_CABEZOTE: "El contenedor sigue sin cabezote",
    YA_ABIERTO: "Este vehículo ya fue reabierto",
    NO_EXISTE: "Este vehículo ya no existe"
};

/*
    Si `error` es un rechazo por integridad, lo muestra (con sonido) y
    devuelve true. Si es otra cosa (red, permisos…), devuelve false para
    que el llamador lo trate como siempre.
*/
export function mostrarRechazo(error) {

    if (!esErrorIntegridad(error)) return false;

    sonar();

    // Una sola a la vez: la nueva reemplaza a la anterior.
    const previa = document.getElementById(ID);
    if (previa) previa.remove();

    const caja = document.createElement("div");
    caja.id = ID;
    caja.setAttribute("role", "alertdialog");
    caja.setAttribute("aria-live", "assertive");
    caja.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;" +
        "background:rgba(10,15,25,.62);padding:16px;";

    caja.innerHTML =
        '<div style="max-width:460px;width:100%;background:#fff;color:#1b2533;border-radius:14px;border-top:8px solid #d03b3b;' +
        'box-shadow:0 24px 60px rgba(0,0,0,.45);padding:22px 24px;font-family:system-ui,Segoe UI,sans-serif;">' +
            '<div style="font-size:19px;font-weight:800;color:#a82a2a;margin-bottom:10px;">⚠ ' + escapar(TITULOS[error.codigo] || "No se pudo guardar") + "</div>" +
            '<div style="font-size:15px;line-height:1.5;margin-bottom:18px;">' + escapar(error.message) + "</div>" +
            '<div style="text-align:right;"><button type="button" data-cerrar style="background:#1b2533;color:#fff;border:0;border-radius:8px;' +
            'padding:10px 20px;font-size:15px;font-weight:700;cursor:pointer;">Entendido</button></div>' +
        "</div>";

    const cerrar = () => { caja.remove(); document.removeEventListener("keydown", alTecla); };
    const alTecla = (e) => { if (e.key === "Escape" || e.key === "Enter") cerrar(); };

    caja.addEventListener("click", (e) => { if (e.target === caja || e.target.closest("[data-cerrar]")) cerrar(); });
    document.addEventListener("keydown", alTecla);
    document.body.appendChild(caja);

    const boton = caja.querySelector("[data-cerrar]");
    if (boton) boton.focus();

    return true;
}
