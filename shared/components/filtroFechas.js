/* =========================================================
   INLOTRANS — Filtro de fechas de Estadísticas (compartido)

   Reemplaza los botones de periodo fijo (Hoy, 3 días, Semana,
   Mes, Todo) y el "Personalizado" escondido detrás de ellos.

   Ahora el rango es LIBRE y siempre visible: Desde / Hasta, y se
   aplica en cuanto se cambia — sin botón "Aplicar". Los atajos
   (Hoy, Ayer, 7 días, 30 días, Este mes, Mes pasado, Todo) solo
   LLENAN las dos fechas; quien filtra puede seguir moviéndolas a
   su gusto después.

   Los días son DÍAS OPERATIVOS (de la hora de corte a la hora de
   corte, 6am a 6am hoy), igual que el resto del panel.

   Uso (en el panel):

       const filtro = conectarFiltroFechas({
           raiz: document.getElementById("view-estadisticas"),
           horaCorte: () => horaCorte,
           diasConDatos: () => registros.map((r) => getDiaOperativo(r, horaCorte)),
           inicial: "hoy",
           onCambio: renderEstadisticas
       });
       filtro.dias()        → ["2026-09-01", …] días del rango
       filtro.recortado()   → días que quedaron por fuera del tope

   Arma su propia barra dentro de `.toolbar-estad` de la vista:
   los HTML de los paneles no hay que tocarlos.
   ========================================================= */

import { todayOperativo, sumarDias } from "../utils/tiempos.js";

// Cada día del rango es un punto en las gráficas: un año es el tope.
export const MAX_DIAS_RANGO = 366;

const ATAJOS = [
    { clave: "hoy", texto: "Hoy" },
    { clave: "ayer", texto: "Ayer" },
    { clave: "7dias", texto: "Últimos 7 días" },
    { clave: "30dias", texto: "Últimos 30 días" },
    { clave: "mes", texto: "Este mes" },
    { clave: "mespasado", texto: "Mes pasado" },
    { clave: "todo", texto: "Todo" }
];

function primeroDelMes(dia) {
    return dia.slice(0, 8) + "01";
}

function fmtCorto(dia) {
    return new Date(dia + "T12:00:00Z").toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
}

function diasEntre(desde, hasta) {
    return Math.round((new Date(hasta + "T12:00:00Z") - new Date(desde + "T12:00:00Z")) / 86400000) + 1;
}

export function conectarFiltroFechas(opciones) {

    const raiz = opciones.raiz;
    const horaCorte = opciones.horaCorte || (() => 6);
    const onCambio = opciones.onCambio || (() => {});
    const clave = "inlotrans:estad-rango:" + location.pathname;

    /* El rango de un atajo se calcula en el momento: "Hoy" tiene
       que seguir siendo hoy después del corte de turno, y "Todo"
       tiene que crecer cuando llegan registros nuevos. */
    function rangoDe(atajo) {
        const hoy = todayOperativo(horaCorte());
        switch (atajo) {
            case "ayer": return [sumarDias(hoy, -1), sumarDias(hoy, -1)];
            case "7dias": return [sumarDias(hoy, -6), hoy];
            case "30dias": return [sumarDias(hoy, -29), hoy];
            case "mes": return [primeroDelMes(hoy), hoy];
            case "mespasado": {
                const fin = sumarDias(primeroDelMes(hoy), -1);
                return [primeroDelMes(fin), fin];
            }
            case "todo": {
                const conDatos = (opciones.diasConDatos ? opciones.diasConDatos() : []).filter(Boolean).sort();
                return conDatos.length ? [conDatos[0], conDatos[conDatos.length - 1] > hoy ? conDatos[conDatos.length - 1] : hoy] : [hoy, hoy];
            }
            default: return [hoy, hoy];
        }
    }

    /* ── Estado: o un atajo vivo, o un rango que alguien escribió ── */
    let atajo = opciones.inicial || "hoy";
    let desde = null;
    let hasta = null;

    try {
        const guardado = JSON.parse(sessionStorage.getItem(clave) || "null");
        if (guardado && guardado.atajo) atajo = guardado.atajo;
        else if (guardado && guardado.desde && guardado.hasta) { atajo = null; desde = guardado.desde; hasta = guardado.hasta; }
    } catch (e) { /* sin almacenamiento: arranca con el valor por defecto */ }

    /* ── La barra ── */
    const viejoRango = raiz.querySelector("#estad-rango-custom");
    if (viejoRango) viejoRango.remove();

    let barra = raiz.querySelector(".toolbar-estad");
    if (!barra) {
        barra = document.createElement("div");
        barra.className = "toolbar-estad";
        raiz.prepend(barra);
    }

    barra.innerHTML =
        '<div class="ff">' +
            '<div class="ff-rango">' +
                '<i class="ti ti-calendar-event ff-icono"></i>' +
                '<label class="ff-campo"><span>Desde</span><input type="date" id="estad-desde"></label>' +
                '<span class="ff-flecha" aria-hidden="true">→</span>' +
                '<label class="ff-campo"><span>Hasta</span><input type="date" id="estad-hasta"></label>' +
            '</div>' +
            '<div class="ff-atajos" role="group" aria-label="Atajos de fecha">' +
                ATAJOS.map((a) => '<button type="button" class="ff-atajo" data-atajo="' + a.clave + '">' + a.texto + '</button>').join("") +
            '</div>' +
            '<div class="ff-resumen" aria-live="polite"></div>' +
        '</div>';

    const inDesde = barra.querySelector("#estad-desde");
    const inHasta = barra.querySelector("#estad-hasta");
    const resumen = barra.querySelector(".ff-resumen");
    let recortado = 0;

    function rangoActual() {
        return atajo ? rangoDe(atajo) : [desde, hasta];
    }

    function guardar() {
        try {
            sessionStorage.setItem(clave, JSON.stringify(atajo ? { atajo } : { desde, hasta }));
        } catch (e) { /* no importa: solo se pierde recordar el rango */ }
    }

    function pintarBarra() {
        const [d, h] = rangoActual();
        inDesde.value = d;
        inHasta.value = h;
        inHasta.min = d;
        inDesde.max = h;

        barra.querySelectorAll(".ff-atajo").forEach((b) => {
            b.classList.toggle("activo", b.dataset.atajo === atajo);
            b.setAttribute("aria-pressed", b.dataset.atajo === atajo ? "true" : "false");
        });

        const n = diasEntre(d, h);
        const prevHasta = sumarDias(d, -1);
        const prevDesde = sumarDias(d, -n);
        resumen.textContent = n + (n === 1 ? " día" : " días") +
            " · se compara con " + fmtCorto(prevDesde) + (n > 1 ? " – " + fmtCorto(prevHasta) : "");
    }

    function cambiar() {
        guardar();
        pintarBarra();
        onCambio();
    }

    barra.querySelectorAll(".ff-atajo").forEach((b) => {
        b.addEventListener("click", () => { atajo = b.dataset.atajo; cambiar(); });
    });

    function alEditar(e) {
        let d = inDesde.value;
        let h = inHasta.value;
        if (!d || !h) return;            // a medio escribir
        if (d > h) {                     // al revés: se acomoda solo
            if (e.target === inDesde) h = d; else d = h;
        }
        atajo = null;
        desde = d;
        hasta = h;
        cambiar();
    }

    inDesde.addEventListener("change", alEditar);
    inHasta.addEventListener("change", alEditar);

    pintarBarra();

    return {
        dias() {
            const [d, h] = rangoActual();
            const lista = [];
            let cur = d;
            while (cur <= h && lista.length < MAX_DIAS_RANGO) {
                lista.push(cur);
                cur = sumarDias(cur, 1);
            }
            recortado = Math.max(0, diasEntre(d, h) - lista.length);
            // Si el día cambió (corte de turno) la barra lo refleja.
            pintarBarra();
            return lista.length ? lista : [todayOperativo(horaCorte())];
        },
        recortado() {
            return recortado;
        },
        rango() {
            return rangoActual();
        }
    };
}
