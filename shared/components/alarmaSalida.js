/* =========================================================
   INLOTRANS
   Alarma de salida pendiente

   Cuando un vehículo termina (avance al 100 % de su última fase)
   y en MINUTOS_ESPERA no le han dado la salida, suena una alarma
   fuerte y repetitiva y aparece un aviso rojo arriba de la
   pantalla con la placa y el botón para darle la salida. No se
   puede silenciar: deja de sonar sola cuando ya no queda ningún
   vehículo pendiente.

   Solo cuenta lo que de verdad puede salir (diagnosticoSalida):
   un contenedor sin cabezote, por ejemplo, no hace sonar nada
   porque todavía no se puede despachar.

   El sonido es WebAudio (sin archivos). Los navegadores no dejan
   sonar hasta que la persona toca la página una vez; mientras
   tanto el aviso lo pide.
   ========================================================= */

import { avanceCompleto, diagnosticoSalida, estaCancelado } from "../services/vehiculos.js";

export const MINUTOS_ESPERA = 3;

/* ── ¿Desde cuándo está lleno? ─────────────────────────────── */

function esUltimaFase(r) {
    // "Ambos" descarga primero y luego carga: solo termina al completar el cargue.
    return r.tipo !== "Ambos" || r.avanceTipo === "Cargue";
}

function llegoA100(e, r) {
    if (!e || e.tipo !== "avance") return false;
    if (e.avanceTipo && r.avanceTipo && e.avanceTipo !== r.avanceTipo) return false;
    if (typeof e.porcentaje === "number") return e.porcentaje >= 100;
    return /\b100\s*%/.test(e.texto || "");
}

// La hora en que el avance llegó a 100 %, o null si no está lleno
// (o el historial no lo dice: registros viejos, sin hora que medir).
export function momentoLleno(r) {
    if (!r || r.horaSalida || estaCancelado(r)) return null;
    if (!avanceCompleto(r) || !esUltimaFase(r)) return null;

    const historial = Array.isArray(r.historial) ? r.historial : [];
    for (let i = historial.length - 1; i >= 0; i--) {
        if (llegoA100(historial[i], r)) {
            const t = new Date(historial[i].fecha);
            return isNaN(t) ? null : t;
        }
    }
    return null;
}

export function pendientesDeSalida(registros, config, ahora) {
    const limite = (ahora || new Date()).getTime() - MINUTOS_ESPERA * 60000;
    return (registros || [])
        .map((r) => ({ r, lleno: momentoLleno(r) }))
        .filter((x) => x.lleno && x.lleno.getTime() <= limite && diagnosticoSalida(x.r, config).puedeSalir)
        .sort((a, b) => a.lleno - b.lleno);
}


/* ── Sonido ─────────────────────────────────────────────────── */

function crearSirena() {

    const Contexto = window.AudioContext || window.webkitAudioContext;
    const ctx = Contexto ? new Contexto() : null;
    let temporizador = null;

    function tono(frecuencia, inicio, duracion) {
        const osc = ctx.createOscillator();
        const vol = ctx.createGain();
        osc.type = "square";
        osc.frequency.setValueAtTime(frecuencia, inicio);
        vol.gain.setValueAtTime(0.0001, inicio);
        vol.gain.exponentialRampToValueAtTime(0.35, inicio + 0.02);
        vol.gain.setValueAtTime(0.35, inicio + duracion - 0.03);
        vol.gain.exponentialRampToValueAtTime(0.0001, inicio + duracion);
        osc.connect(vol).connect(ctx.destination);
        osc.start(inicio);
        osc.stop(inicio + duracion + 0.02);
    }

    // Dos tonos alternados, tres veces por ciclo: el típico pitido de alarma.
    function ciclo() {
        if (!ctx || ctx.state !== "running") return;
        const t = ctx.currentTime + 0.02;
        for (let i = 0; i < 3; i++) {
            tono(1050, t + i * 0.5, 0.22);
            tono(760, t + i * 0.5 + 0.25, 0.22);
        }
    }

    // El navegador solo deja sonar tras un gesto de la persona.
    function desbloquear() {
        if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
    }
    ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
        document.addEventListener(ev, desbloquear, { capture: true, passive: true }));

    return {
        bloqueado: () => !ctx || ctx.state !== "running",
        encender() {
            if (temporizador) return;
            ciclo();
            temporizador = setInterval(ciclo, 1600);
        },
        apagar() {
            clearInterval(temporizador);
            temporizador = null;
        }
    };
}


/* ── Aviso en pantalla ──────────────────────────────────────── */

const ESTILO = `
.alarma-salida { position: fixed; top: 0; left: 0; right: 0; z-index: 10000;
  background: #b91c1c; color: #fff; padding: 10px 16px; box-shadow: 0 4px 18px rgba(0,0,0,.35);
  font: 600 14px/1.35 "Segoe UI", system-ui, sans-serif; animation: alarma-salida-parpadeo 1s steps(2, start) infinite; }
@keyframes alarma-salida-parpadeo { 50% { background: #7f1d1d; } }
.alarma-salida-titulo { font-size: 16px; font-weight: 800; display: flex; align-items: center; gap: 8px; }
.alarma-salida-lista { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.alarma-salida-item { background: rgba(255,255,255,.14); border-radius: 8px; padding: 6px 10px; display: flex; align-items: center; gap: 10px; }
.alarma-salida-item button { background: #fff; color: #b91c1c; border: 0; border-radius: 6px; padding: 5px 10px; font-weight: 800; cursor: pointer; }
.alarma-salida-sonido { margin-top: 6px; font-weight: 700; color: #fde68a; }
`;

function escapar(texto) {
    return String(texto == null ? "" : texto).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function minutosDesde(fecha, ahora) {
    return Math.max(0, Math.floor((ahora - fecha) / 60000));
}


/*
    crearAlarmaSalida({ alDarSalida, obtenerConfig, puedeDarSalida })

      alDarSalida(id)   abre el modal de salida de ese vehículo
      obtenerConfig()   la configuración actual de la bodega
      puedeDarSalida()  si quien está conectado da salidas: solo a
                        esa persona le suena (a quien no puede
                        hacer nada, la alarma solo le estorbaría)

    Devuelve { actualizar(registros) }: llamarlo en cada cambio.
*/
export function crearAlarmaSalida({ alDarSalida, obtenerConfig, puedeDarSalida }) {

    const estilo = document.createElement("style");
    estilo.textContent = ESTILO;
    document.head.appendChild(estilo);

    const aviso = document.createElement("div");
    aviso.className = "alarma-salida";
    aviso.setAttribute("role", "alert");
    aviso.hidden = true;
    document.body.appendChild(aviso);

    aviso.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-alarma-salida]");
        if (btn) alDarSalida(btn.getAttribute("data-alarma-salida"));
    });

    const sirena = crearSirena();
    let registros = [];

    function revisar() {
        if (!puedeDarSalida()) {
            aviso.hidden = true;
            sirena.apagar();
            return;
        }

        const ahora = new Date();
        const pendientes = pendientesDeSalida(registros, obtenerConfig(), ahora);

        if (!pendientes.length) {
            aviso.hidden = true;
            sirena.apagar();
            return;
        }

        aviso.innerHTML =
            `<div class="alarma-salida-titulo">🚨 ${pendientes.length === 1 ? "Un vehículo ya está listo" : pendientes.length + " vehículos ya están listos"} y NO le han dado la salida</div>` +
            `<div class="alarma-salida-lista">` +
            pendientes.map(({ r, lleno }) =>
                `<div class="alarma-salida-item"><span><strong>${escapar(r.placa)}</strong> · ` +
                `${escapar(r.ubicacion === "Muelle" && r.numeroMuelle ? "Muelle " + r.numeroMuelle : (r.ubicacion || ""))} · ` +
                `lleno hace ${minutosDesde(lleno, ahora)} min</span>` +
                `<button type="button" data-alarma-salida="${escapar(r.id)}">Dar salida</button></div>`
            ).join("") +
            `</div>` +
            (sirena.bloqueado() ? `<div class="alarma-salida-sonido">🔇 Toca cualquier parte de la pantalla para activar el sonido de la alarma.</div>` : "");

        aviso.hidden = false;
        sirena.encender();
    }

    // Cada 10 s: el reloj de los 3 minutos corre aunque no llegue ningún cambio.
    setInterval(revisar, 10000);

    return {
        actualizar(nuevos) {
            registros = nuevos || [];
            revisar();
        }
    };
}
