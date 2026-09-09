/* =========================================================
   INLOTRANS — Revisión de datos (herramienta de mantenimiento)

   Por qué existe: cuando los registros no se crean desde la
   portería sino que se inyectan por fuera (consola de Firebase,
   un script, una carga masiva), es fácil que lleguen sin alguno
   de los campos de los que cuelgan los indicadores. El panel de
   estadísticas no falla —está escrito para no romperse con datos
   incompletos— pero eso mismo hace que el síntoma sea un "—" o
   un cero, sin decir por qué.

   Esta página hace ese diagnóstico: lee los vehículos de una
   bodega, revisa campo por campo lo que cada indicador necesita,
   y dice cuántos registros fallan, QUÉ indicador deja sin datos
   cada problema y con qué placas comprobarlo.

   NO ESCRIBE NADA. Es solo lectura, a propósito: qué hacer con
   los registros malos (corregirlos a mano, reinyectarlos, o
   dejarlos) es una decisión que depende de cuántos sean y de
   dónde salieron, y no algo que esta página deba resolver sola.

   Solo administrador: la colección "vehiculos" es compartida por
   las tres bodegas.
   ========================================================= */

import { protegerPagina } from "../shared/core/guard.js";
import { cerrarSesionFirebase } from "../shared/core/auth.js";
import { cerrarSesionLocal } from "../shared/core/session.js";
import { db } from "../shared/core/firebase.js";

import {
    collection,
    query,
    where,
    getDocs
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { obtenerConfig, numerosDeMuelle } from "../shared/services/config.js";
import { getLocationDurations } from "../shared/services/eventos.js";

const TIPOS_VALIDOS = ["Cargue", "Descargue", "Ambos"];

let registros = [];
let cobros = {};
let config = null;

protegerPagina({ rolesPermitidos: ["administrador"] })
    .then(function (perfil) {
        document.getElementById("nombre-usuario").textContent = perfil.nombre || perfil.uid;
        document.getElementById("btn-escanear").addEventListener("click", escanear);

        /* El color de la página sigue a la bodega elegida. Los colores
           viven en css/base.css; aquí solo se dice cuál está abierta.
           Va en el 'change' del selector y no al escanear: el informe
           que queda en pantalla es el de la bodega anterior hasta que
           se vuelva a escanear, pero lo que se está por consultar es
           la nueva, y es esa la que hay que ver antes de pulsar. */
        const selOp = document.getElementById("op");
        selOp.addEventListener("change", function () {
            document.documentElement.setAttribute("data-operacion", selOp.value);
        });
        document.getElementById("btn-salir").addEventListener("click", async function () {
            await cerrarSesionFirebase();
            cerrarSesionLocal();
            window.location.href = "../index.html";
        });
    })
    .catch(function () {
        // protegerPagina ya redirigió
    });


function escapar(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function esFechaValida(v) {
    if (!v) return false;
    const d = new Date(v);
    return !isNaN(d.getTime());
}

/* Un destino "reconocible" es el que getLocationDurations() sabe
   clasificar: tiene que EMPEZAR por "Patio" o por "Muelle". Es la
   condición de la que cuelgan todos los tiempos, y la que más se
   pierde en una inyección — ver el comentario de `noMedible` en
   eventos.js. */
function destinoReconocible(r) {
    const d = String((r && (r.destino || r.muelle)) || "");
    return d.indexOf("Patio") === 0 || d.indexOf("Muelle") === 0;
}


async function escanear() {

    const operacion = document.getElementById("op").value;
    const btn = document.getElementById("btn-escanear");

    btn.disabled = true;
    btn.textContent = "Leyendo…";

    try {
        const snap = await getDocs(query(collection(db, "vehiculos"), where("operacion", "==", operacion)));
        registros = [];
        snap.forEach(function (d) { registros.push(Object.assign({ id: d.id }, d.data())); });

        config = await obtenerConfig(operacion);

        // Los cobros pueden no existir (bodega que no cobra) o no
        // dejarse leer; ninguna de las dos es un error del escaneo.
        cobros = {};
        try {
            const sc = await getDocs(query(collection(db, "cobros"), where("operacion", "==", operacion)));
            sc.forEach(function (d) { cobros[d.id] = d.data(); });
        } catch (e) {
            console.warn("No se pudieron leer los cobros:", e);
        }

        renderInforme(operacion);

    } catch (error) {
        console.error("Error al escanear:", error);
        document.getElementById("informe").innerHTML =
            '<div class="hallazgo grave"><h3>No se pudo leer</h3><p>' + escapar(error && error.message) + "</p></div>";
    } finally {
        btn.disabled = false;
        btn.textContent = "Escanear";
    }
}


/* Cada revisión devuelve los registros que FALLAN esa condición,
   junto con qué indicador queda sin datos por eso. El orden es el
   de gravedad: primero lo que borra un registro del panel entero,
   después lo que solo apaga un indicador. */
function revisiones(operacion) {

    const muellesValidos = numerosDeMuelle(config).map(String);

    return [
        {
            grave: true,
            titulo: "Sin hora de entrada válida",
            rompe: "TODO el panel de estadísticas. El periodo (hoy, semana, mes) se calcula sobre `horaEntrada`: " +
                   "un registro sin ella no cae en ningún día y desaparece de todas las tarjetas, gráficas y tablas.",
            arreglo: "Cada registro necesita `horaEntrada` en formato \"AAAA-MM-DDTHH:MM\".",
            falla: (r) => !esFechaValida(r.horaEntrada)
        },
        {
            grave: true,
            titulo: "Destino no reconocible",
            rompe: "Todos los tiempos: promedio en patio, promedio en muelle, pérdida de operación, árbol de " +
                   "oportunidades, cumplimiento por tipología y tiempos segmentados. Los registros aparecen " +
                   "contados en \"entradas\" pero salen de todos los promedios como \"descartados\".",
            arreglo: "`destino` tiene que EMPEZAR por \"Patio\" o por \"Muelle\" — por ejemplo \"Patio\" o " +
                     "\"Muelle 9 - Bahía A\". Es lo que lee getLocationDurations() para saber dónde estuvo el vehículo.",
            falla: (r) => !destinoReconocible(r)
        },
        {
            grave: true,
            titulo: "Terminados sin tiempos utilizables",
            rompe: "Los promedios de patio y muelle. Son vehículos que entraron y salieron pero cuyo historial " +
                   "no atribuye un solo minuto a ninguna ubicación, casi siempre porque el destino no es " +
                   "reconocible o porque la hora de salida quedó ANTES del último movimiento.",
            arreglo: "Revisa `destino`, `historial` y que `horaSalida` sea posterior a `horaEntrada`.",
            falla: (r) => {
                if (!r.horaSalida || !esFechaValida(r.horaEntrada)) return false;
                const d = getLocationDurations(r);
                if ((d.patio || 0) + (d.muelle || 0) > 0) return false;
                return (new Date(r.horaSalida) - new Date(r.horaEntrada)) / 60000 > 1;
            }
        },
        {
            titulo: "Sin historial",
            rompe: "La ficha de trazabilidad del vehículo y el reparto de tiempo entre patio y muelle. " +
                   "Se reconstruye uno mínimo a partir de horaEntrada/horaSalida, pero solo sirve si el " +
                   "destino es reconocible, y un vehículo que pasó por patio Y por muelle queda con todo el " +
                   "tiempo cargado a un solo sitio.",
            arreglo: "Idealmente cada registro trae `historial` con sus eventos. Si no, al menos `destino` correcto.",
            falla: (r) => !Array.isArray(r.historial) || !r.historial.length
        },
        {
            titulo: "Tipo de operación inválido",
            rompe: "Tarjeta \"Con cargue\", gráfica de tipo de operación, tabla de promedio por tipo, tabla " +
                   "segmentada y el árbol de oportunidades (la rama por tipo).",
            arreglo: "`tipo` debe ser exactamente \"Cargue\", \"Descargue\" o \"Ambos\".",
            falla: (r) => TIPOS_VALIDOS.indexOf(r.tipo) === -1
        },
        {
            titulo: "Sin tipología asignada",
            rompe: "Cumplimiento por tipología (caen en la fila \"Sin tipología\") y el cobro: un vehículo sin " +
                   "tipología no tiene tarifa, así que no se puede cobrar ni cuenta como pendiente de cobro.",
            arreglo: "`tipologia` debe traer el ID de una tipología de la configuración de la bodega, y " +
                     "`tipologiaNombre` su nombre.",
            falla: (r) => !r.tipologia
        },
        {
            titulo: "Tipología que ya no existe en la configuración",
            rompe: "El cumplimiento contra la meta de muelle: sin tipología válida no hay meta contra la cual medir.",
            arreglo: "El ID de `tipologia` no está en config/" + operacion + ". Reasígnala o vuelve a crearla.",
            falla: (r) => {
                if (!r.tipologia) return false;
                return !(config.tipologias || []).some((t) => t.id === r.tipologia);
            }
        },
        {
            titulo: "Programado pero sin hora de cita",
            rompe: "El cumplimiento de cita (on time) y la mitad \"cita\" del índice de nivel de servicio: " +
                   "quedan fuera del indicador y se cuentan como \"sin cita\".",
            arreglo: "Si `programado` es true, `horaProgramacion` tiene que traer la fecha y hora de la cita.",
            falla: (r) => r.programado === true && !esFechaValida(r.horaProgramacion)
        },
        {
            titulo: "Sin canal",
            rompe: "Nada, pero todos caen en el canal \"Otro\": la gráfica por canal, la tabla por canal y el " +
                   "árbol de oportunidades quedan con una sola barra y dejan de servir para comparar.",
            arreglo: "`canal` debería ser \"MQ\" o \"3PD\".",
            falla: (r) => !r.canal
        },
        {
            titulo: "En muelle con un número fuera de la numeración",
            rompe: "Nada se pierde —el tablero los sigue mostrando— pero aparecen como tarjetas extra fuera de " +
                   "los muelles " + (muellesValidos.join(", ") || "configurados") + ".",
            arreglo: "`numeroMuelle` debe ser uno de: " + (muellesValidos.join(", ") || "(sin muelles configurados)") + ".",
            falla: (r) => !r.horaSalida && r.ubicacion === "Muelle" &&
                          r.numeroMuelle && muellesValidos.indexOf(String(r.numeroMuelle)) === -1
        },
        {
            titulo: "Sin avance de cargue/descargue",
            rompe: "El bloque de avance de la ficha y el cumplimiento de la regla de salida: estos vehículos " +
                   "pueden salir sin restricción de porcentaje.",
            arreglo: "Usa la herramienta de Backfill de avance, que ya existe para esto.",
            falla: (r) => !r.horaSalida && (r.avancePorcentaje === undefined || r.avancePorcentaje === null)
        },
        {
            titulo: "Sin operador de entrada",
            rompe: "La gráfica \"Vehículos por operador\" y la tabla \"Muelles más usados por operario\": " +
                   "todos se agrupan bajo \"—\".",
            arreglo: "`operadorEntrada` con el nombre de quien recibió el vehículo.",
            falla: (r) => !r.operadorEntrada
        },
        {
            titulo: "Fecha del día operativo descuadrada",
            rompe: "El filtro por fecha de la vista de Registros, que usa `fecha` mientras las estadísticas usan " +
                   "`horaEntrada`. Si no coinciden, un vehículo se busca en un día y se cuenta en otro.",
            arreglo: "`fecha` debe ser los primeros 10 caracteres de `horaEntrada`.",
            falla: (r) => esFechaValida(r.horaEntrada) && r.fecha !== String(r.horaEntrada).slice(0, 10)
        }
    ];
}


function renderInforme(operacion) {

    const cont = document.getElementById("informe");

    if (!registros.length) {
        cont.innerHTML = '<div class="hallazgo grave"><h3>No hay registros en ' + escapar(operacion) + "</h3>" +
            "<p>La consulta no devolvió ningún vehículo. Si inyectaste datos, revisa que cada documento tenga " +
            'el campo <code>operacion</code> exactamente igual a "' + escapar(operacion) + '" — es lo que ' +
            "separa las bodegas y lo que filtran todas las consultas del sistema.</p></div>";
        return;
    }

    const terminados = registros.filter((r) => r.horaSalida).length;
    const cobrables = registros.filter((r) => r.tipologia).length;
    const conCobro = registros.filter((r) => cobros[r.id]).length;

    let html = '<div class="resumen">' +
        tarjeta("Registros leídos", registros.length) +
        tarjeta("Terminados (con salida)", terminados) +
        tarjeta("Activos", registros.length - terminados) +
        tarjeta("Con tipología", cobrables) +
        tarjeta("Con cobro registrado", conCobro) +
        "</div>";

    html += '<p class="nota">Los promedios de tiempo solo cuentan vehículos <strong>terminados</strong>. ' +
        "Si casi todos están activos, las tarjetas de promedio salen en “—” y eso es correcto, no un error.</p>";

    const encontrados = [];
    const limpios = [];

    revisiones(operacion).forEach(function (rev) {
        const malos = registros.filter(rev.falla);
        if (malos.length) encontrados.push({ rev: rev, malos: malos });
        else limpios.push(rev.titulo);
    });

    if (!encontrados.length) {
        html += '<div class="hallazgo ok"><h3>Los datos están completos</h3>' +
            "<p>Ninguna de las " + revisiones(operacion).length + " revisiones encontró problemas. " +
            "Si aun así ves un indicador vacío, no es por los datos: avísame cuál y lo miramos.</p></div>";
        cont.innerHTML = html;
        return;
    }

    encontrados.forEach(function (h) {
        const pct = Math.round((h.malos.length / registros.length) * 100);
        const ejemplos = h.malos.slice(0, 8).map((r) => r.placa || r.id).join(", ");

        html += '<div class="hallazgo ' + (h.rev.grave ? "grave" : "aviso") + '">' +
            "<h3>" + escapar(h.rev.titulo) +
            ' <span class="cuenta">' + h.malos.length + " de " + registros.length + " (" + pct + "%)</span></h3>" +
            "<p><strong>Qué deja sin datos:</strong> " + h.rev.rompe + "</p>" +
            "<p><strong>Cómo se arregla:</strong> " + h.rev.arreglo + "</p>" +
            '<p class="ejemplos"><strong>Ejemplos:</strong> ' + escapar(ejemplos) +
            (h.malos.length > 8 ? " … y " + (h.malos.length - 8) + " más" : "") + "</p>" +
            "</div>";
    });

    if (limpios.length) {
        html += '<div class="hallazgo ok"><h3>Revisiones que pasaron</h3><p>' +
            limpios.map(escapar).join(" · ") + "</p></div>";
    }

    cont.innerHTML = html;
}

function tarjeta(titulo, valor) {
    return '<div class="t"><div class="t-valor">' + valor + '</div><div class="t-label">' + escapar(titulo) + "</div></div>";
}
