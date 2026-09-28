/* =========================================================
   INLOTRANS — Tablero de muelles (componente compartido)

   La grilla de muelles que hoy existe copiada en los paneles de
   portería y supervisor de las tres bodegas, aquí una sola vez y
   con una diferencia de fondo en cómo se dibuja.

   ── POR QUÉ NO SE USA innerHTML ──

   Los paneles actuales hacen, en cada snapshot de Firestore:

       document.getElementById('muelles-grid').innerHTML = html;

   Es decir: destruyen y vuelven a crear las ocho tarjetas cada
   vez que cambia cualquier vehículo de la bodega. Funciona
   mientras nada se mueva, y deja de funcionar en el momento en
   que algo se anima, porque una animación anima NODOS: si el nodo
   desaparece a mitad del recorrido, la animación muere con él y
   lo que se ve es un parpadeo.

   Aquí cada muelle tiene su nodo y lo conserva. `actualizar()`
   compara lo que llega contra lo último que se pintó y toca solo
   lo que cambió. Eso da tres cosas que el innerHTML no puede dar:

     · las animaciones sobreviven a los cambios de datos;
     · el navegador no rehace ocho tarjetas para cambiar un
       porcentaje, que en un televisor de bodega —equipo modesto,
       encendido todo el turno— se nota;
     · lo que el operario está señalando con el dedo no se le
       mueve de debajo cuando entra otro camión.

   ── QUÉ SABE Y QUÉ NO SABE ESTE COMPONENTE ──

   Sabe pintar muelles. No sabe de Firestore, ni de permisos, ni
   de qué bodega es: recibe los números de muelle, los registros y
   la configuración, y devuelve un objeto con `actualizar()` y
   `destruir()`. Quien lo usa decide de dónde salen esos datos.

   Las acciones (mover, observación, salida) las pone quien monta
   el componente, con `opciones.acciones`. No están escritas aquí
   porque no son las mismas en todas partes: la portería mueve y
   despacha, el supervisor autoriza, y una pantalla colgada en la
   caseta no hace ninguna de las dos. El componente sabe dónde van
   los botones; qué botones son es del panel.
   ========================================================= */

import {
    minutosEnMuelle,
    nivelContraMeta,
    faseActual
} from "../services/eventos.js";

import {
    tiemposDe,
    modalidadDe,
    distingueModalidad,
    etiquetaCampo
} from "../services/config.js";

import { requiereAvanceCompleto, estaCancelado } from "../services/vehiculos.js";
import { formatDuration } from "../utils/tiempos.js";

import {
    aparecerEnCascada,
    aparecer,
    llegarAlMuelle,
    destacarCambio,
    desaparecer,
    pulsar,
    pararPulso
} from "./animaciones.js";


/* =========================================================
   EL DIBUJO DEL MUELLE

   Cada tarjeta lleva un SVG con dos escenas superpuestas: la
   bahía vacía y el camión arrimado. Se enseña una u otra.

   ── POR QUÉ SVG EN LÍNEA ──

   Ni imágenes ni tipografía de iconos. Un SVG escrito aquí se
   pinta con los mismos tokens de tema que el resto (`currentColor`
   y las variables del semáforo), escala a cualquier tamaño de
   tarjeta sin pixelarse, y sus piezas son nodos que se pueden
   animar por separado. Un PNG no hace ninguna de las tres, y una
   fuente de iconos no deja rellenar el remolque.

   ── EL REMOLQUE ES LA BARRA DE AVANCE ──

   Esto es lo que hace que el dibujo no sea decoración: la carga
   dentro del remolque crece con el porcentaje. Se lee el avance
   en la forma, de lejos y sin buscar una cifra, y sigue estando
   el número al lado para cuando hay que comparar contra el mínimo
   exacto del 95%. Por eso desapareció la barrita que había antes:
   era la misma información dos veces.

   ── LA ORIENTACIÓN NO ES CAPRICHO ──

   El camión va de culo al muelle, con las puertas del remolque
   contra la plataforma y la cabeza apuntando a la salida. Es como
   se estaciona de verdad, y el operario que mira la tarjeta está
   viendo lo mismo que vería asomándose.
   ========================================================= */

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(nombre, atributos) {
    const el = document.createElementNS(SVG_NS, nombre);
    for (const clave in atributos) {
        if (Object.prototype.hasOwnProperty.call(atributos, clave)) {
            el.setAttribute(clave, atributos[clave]);
        }
    }
    return el;
}

/*
    Construye el dibujo del muelle `numero`.

    El número entra porque los `id` de un SVG son globales al
    documento: con ocho muelles habría ocho clipPath llamados
    igual, y el navegador resuelve todas las referencias contra el
    primero. El resultado sería que los ocho remolques se llenan
    con el porcentaje del muelle 1 — un fallo que no da error en
    consola y que solo se ve cuando dos muelles van a distinto
    avance.
*/
function construirDibujo(numero) {

    const idCarga = "tm-carga-" + numero;

    const svg = svgEl("svg", {
        class: "tm-dibujo",
        viewBox: "0 0 240 96",
        role: "img",
        "aria-hidden": "true",
        preserveAspectRatio: "xMidYMid meet"
    });

    /* ── La plataforma del muelle ──
       Está en las dos escenas: el muelle existe con camión y sin
       él, y dejarla fija da el punto de referencia contra el que
       se lee que el camión llegó. */
    const anden = svgEl("g", { class: "tm-anden" });
    anden.appendChild(svgEl("rect", { x: 0, y: 8, width: 16, height: 66, rx: 2 }));
    anden.appendChild(svgEl("rect", { x: 0, y: 4, width: 22, height: 6, rx: 2, class: "tm-anden-borde" }));
    svg.appendChild(anden);

    // El suelo, común a las dos escenas.
    svg.appendChild(svgEl("line", { x1: 0, y1: 84, x2: 240, y2: 84, class: "tm-suelo" }));

    /* ── Escena A: la bahía vacía ──
       La silueta de lo que cabe, punteada, más las guías del suelo
       que marcan dónde retroceder. Dice "aquí cabe un camión" en
       vez de dejar un hueco en blanco, que es lo que pedía el
       boceto: un vacío que se lee como sitio disponible y no como
       tarjeta a medio cargar. */
    const bahia = svgEl("g", { class: "tm-bahia" });
    bahia.appendChild(svgEl("rect", {
        x: 26, y: 20, width: 186, height: 54, rx: 4, class: "tm-bahia-silueta"
    }));
    // Guías del suelo: dos líneas que convergen hacia el andén.
    bahia.appendChild(svgEl("line", { x1: 34, y1: 80, x2: 60, y2: 80, class: "tm-bahia-guia" }));
    bahia.appendChild(svgEl("line", { x1: 74, y1: 80, x2: 100, y2: 80, class: "tm-bahia-guia" }));
    bahia.appendChild(svgEl("line", { x1: 114, y1: 80, x2: 140, y2: 80, class: "tm-bahia-guia" }));
    bahia.appendChild(svgEl("line", { x1: 154, y1: 80, x2: 180, y2: 80, class: "tm-bahia-guia" }));
    svg.appendChild(bahia);

    /* ── Escena B: el camión ── */
    const camion = svgEl("g", { class: "tm-camion" });

    // Zona de carga del remolque, recortada para el relleno.
    const defs = svgEl("defs", {});
    const clip = svgEl("clipPath", { id: idCarga });
    clip.appendChild(svgEl("rect", { x: 28, y: 22, width: 116, height: 44, rx: 2 }));
    defs.appendChild(clip);
    camion.appendChild(defs);

    // El remolque, vacío.
    camion.appendChild(svgEl("rect", {
        x: 26, y: 20, width: 120, height: 48, rx: 3, class: "tm-remolque"
    }));

    /* La carga. Crece desde el andén hacia la cabeza, que es el
       sentido en el que se llena un remolque por su puerta
       trasera.

       Nace a ancho COMPLETO y se encoge con `scaleX`; no se le
       cambia el `width`. La diferencia importa: el atributo width
       de un rect no es animable de forma fiable —fue propiedad CSS
       solo a partir de SVG2 y los navegadores llegaron tarde y
       desigual—, mientras que `transform` se interpola en todos y
       además lo hace la GPU, sin tocar el hilo principal. */
    const carga = svgEl("rect", {
        x: 28, y: 22, width: 116, height: 44,
        "clip-path": "url(#" + idCarga + ")",
        class: "tm-carga"
    });
    camion.appendChild(carga);

    // Las puertas traseras, contra el andén.
    camion.appendChild(svgEl("line", { x1: 30, y1: 22, x2: 30, y2: 66, class: "tm-remolque-puerta" }));

    // El chasis entre remolque y cabeza.
    camion.appendChild(svgEl("rect", { x: 146, y: 56, width: 40, height: 8, class: "tm-chasis" }));

    /* La cabeza. El morro inclinado es lo que hace que se lea como
       camión y no como dos cajas: sin esa diagonal la silueta es
       ambigua a este tamaño. */
    camion.appendChild(svgEl("path", {
        class: "tm-cabina",
        d: "M186 64 L186 30 Q186 26 190 26 L206 26 L218 44 L218 64 Z"
    }));
    // La ventanilla.
    camion.appendChild(svgEl("path", {
        class: "tm-ventana",
        d: "M192 32 L204 32 L212 43 L192 43 Z"
    }));

    // Las ruedas: el bogie del remolque atrás y los dos ejes de la
    // cabeza. Van en su propio grupo para poder girarlas al llegar.
    const ruedas = svgEl("g", { class: "tm-ruedas" });
    [52, 78, 158, 204].forEach(function (cx) {
        ruedas.appendChild(svgEl("circle", { cx: cx, cy: 74, r: 10, class: "tm-rueda" }));
        ruedas.appendChild(svgEl("circle", { cx: cx, cy: 74, r: 4, class: "tm-rueda-eje" }));
    });
    camion.appendChild(ruedas);

    svg.appendChild(camion);

    return { svg: svg, camion: camion, bahia: bahia, carga: carga };
}


/* Cuánta carga lleva el remolque, de 0 a 100. El encogido va por
   CSS (transition sobre transform en .tm-carga); aquí solo se
   fija el destino. */
function llenarRemolque(carga, pct) {
    if (!carga) return;
    const fraccion = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
    carga.style.transform = "scaleX(" + fraccion + ")";
}


/*
    Crea el tablero dentro de `contenedor`.

    opciones:
        acciones(registro)  devuelve el HTML de los botones de esa
                            tarjeta, o "" si no hay. Opcional: sin
                            esto las tarjetas son de solo lectura.

        extras(registro)    HTML que este panel mete de su cosecha
                            entre la tipología y el avance. Es por
                            donde el supervisor pasa su badge de
                            canal, su selector de modalidad y su
                            avance EDITABLE, y el cliente su avance
                            de solo lectura. Opcional.

        mostrarAvance       false cuando el panel dibuja su propio
                            avance en `extras` — si no, la tarjeta
                            enseñaría dos. Por defecto true.

        onSeleccion(id)     se llama al hacer clic en un muelle
                            ocupado, fuera de los botones y de
                            cualquier control. Opcional.
*/
export function crearTableroMuelles(contenedor, opciones) {

    opciones = opciones || {};

    /* La clave del componente: número de muelle → { nodo, refs,
       estado }. `estado` es lo último que se pintó, y es contra
       eso que se compara para no tocar el DOM sin necesidad. */
    const tarjetas = new Map();

    let primeraPintada = true;

    function alHacerClic(evento) {
        if (typeof opciones.onSeleccion !== "function") return;

        /* Un clic en un control NO es un clic en la tarjeta. Sin
           esto, pulsar "Salida" abriría además la ficha por detrás
           del modal, y desplegar el selector de modalidad del
           supervisor abriría la ficha en vez de abrir el
           desplegable. */
        if (evento.target.closest("button, a, select, input, textarea, label")) return;

        const tarjeta = evento.target.closest("[data-vehiculo]");
        if (tarjeta) opciones.onSeleccion(tarjeta.getAttribute("data-vehiculo"));
    }

    if (typeof opciones.onSeleccion === "function") {
        contenedor.addEventListener("click", alHacerClic);
    }


    /* ── Construcción del nodo, una sola vez por muelle ──────
       Se guardan referencias a cada trozo que después cambia.
       Buscar con querySelector en cada actualización daría el
       mismo resultado y sería recorrer el árbol ocho veces por
       snapshot para nada. */
    function construirTarjeta(numero) {

        const root = document.createElement("article");
        root.className = "tm-card tm-libre";
        root.setAttribute("data-muelle", String(numero));

        const cabecera = document.createElement("header");
        cabecera.className = "tm-head";

        const num = document.createElement("span");
        num.className = "tm-num";
        num.textContent = "M" + numero;

        const estado = document.createElement("span");
        estado.className = "tm-estado";
        estado.textContent = "LIBRE";

        cabecera.appendChild(num);
        cabecera.appendChild(estado);

        const cuerpo = document.createElement("div");
        cuerpo.className = "tm-body";

        /* El dibujo. Está FUERA del bloque de "ocupado" y del de
           "vacío" a propósito: es el mismo muelle en los dos
           estados, y lo que cambia es qué escena se enseña. Si
           cada estado trajera su propio SVG, el andén saltaría al
           llegar un camión en vez de quedarse quieto mientras el
           camión entra. */
        const dibujo = construirDibujo(numero);
        cuerpo.appendChild(dibujo.svg);

        // Vacío: el rótulo bajo la bahía dibujada.
        const vacio = document.createElement("div");
        vacio.className = "tm-vacio";
        vacio.textContent = "Disponible";

        // Ocupado: todo el bloque del vehículo. Se construye
        // siempre, aunque el muelle esté libre, y se enseña o se
        // esconde. Crearlo y destruirlo según el estado sería
        // volver por la puerta de atrás al problema del innerHTML.
        const ocupado = document.createElement("div");
        ocupado.className = "tm-ocupado";

        const placa = document.createElement("div");
        placa.className = "tm-placa";

        const conductor = document.createElement("div");
        conductor.className = "tm-conductor";

        const tipologia = document.createElement("div");
        tipologia.className = "tm-tipologia";

        /* El hueco de cada panel. Va antes del avance porque lo que
           se mete aquí lo describe —el canal, la modalidad— o lo
           sustituye, y en los dos casos se lee antes. */
        const extras = document.createElement("div");
        extras.className = "tm-extras";

        const avance = document.createElement("div");
        avance.className = "tm-avance";

        const avanceTop = document.createElement("div");
        avanceTop.className = "tm-avance-top";

        const fase = document.createElement("span");
        fase.className = "tm-fase";

        const pct = document.createElement("span");
        pct.className = "tm-pct";

        avanceTop.appendChild(fase);
        avanceTop.appendChild(pct);

        /* Aquí había una barrita de avance. Se fue: el remolque del
           dibujo ya la cuenta, y tener las dos era decir lo mismo
           dos veces en una tarjeta que no sobra de sitio. Lo que se
           conserva es el NÚMERO, porque el mínimo de salida es un
           95% exacto y eso no se lee de una forma. */
        avance.appendChild(avanceTop);

        const meta = document.createElement("div");
        meta.className = "tm-meta";

        /* Los botones. Es el único sitio del componente donde se
           escribe innerHTML, y se acepta por dos razones: el panel
           los define como cadena (igual que el resto de sus
           tablas), y es un nodo hoja sin nada animado dentro, así
           que reescribirlo no puede cortar ninguna animación. Solo
           se reescribe cuando la cadena cambia — ver pintarTarjeta. */
        const acciones = document.createElement("div");
        acciones.className = "tm-acciones";

        ocupado.appendChild(placa);
        ocupado.appendChild(conductor);
        ocupado.appendChild(tipologia);
        ocupado.appendChild(extras);
        ocupado.appendChild(avance);
        ocupado.appendChild(meta);
        ocupado.appendChild(acciones);

        cuerpo.appendChild(vacio);
        cuerpo.appendChild(ocupado);

        root.appendChild(cabecera);
        root.appendChild(cuerpo);

        return {
            root: root,
            refs: {
                estado: estado,
                vacio: vacio,
                ocupado: ocupado,
                placa: placa,
                conductor: conductor,
                tipologia: tipologia,
                extras: extras,
                avance: avance,
                fase: fase,
                pct: pct,
                meta: meta,
                acciones: acciones,
                camion: dibujo.camion,
                bahia: dibujo.bahia,
                carga: dibujo.carga
            },
            estado: null   // nada pintado todavía
        };
    }


    /* ── Lo que hay que pintar de un muelle ──────────────────
       Se calcula todo aquí y se compara como un bloque. Tener el
       "qué debería decir esta tarjeta" separado del "cómo se
       escribe en el DOM" es lo que hace el diff posible. */
    function leerMuelle(registro, config) {

        if (!registro) {
            return { ocupado: false };
        }

        const min = minutosEnMuelle(registro);
        const umbrales = tiemposDe(
            config,
            registro.tipologia,
            faseActual(registro),
            modalidadDe(registro)
        );

        const nivel = umbrales ? nivelContraMeta(min, umbrales) : "normal";
        const conAvance = requiereAvanceCompleto(registro);

        // Sin meta se dice en voz alta. Una tarjeta sin cifra se
        // lee como "va bien", y lo que pasa es que a ese vehículo
        // le falta la tipología — que es lo que hay que ir a
        // corregir, y desde el tablero se ve de lejos.
        let textoMeta;
        if (!umbrales) {
            textoMeta = formatDuration(min) + " en muelle · sin meta (falta tipología)";
        } else {
            textoMeta = formatDuration(min) + " de " + formatDuration(umbrales.meta) +
                (nivel !== "normal"
                    ? " · " + formatDuration(min - umbrales.meta) + " por encima"
                    : "");
        }

        const modalidad = distingueModalidad(config) ? modalidadDe(registro) : "";

        return {
            ocupado: true,
            id: registro.id,
            placa: registro.placa || "—",
            conductor: registro.conductor || "",
            tipologia: [registro.tipologiaNombre || "Sin tipología", modalidad]
                .filter(Boolean).join(" · "),
            conAvance: conAvance,
            fase: faseActual(registro) || "—",
            pct: conAvance ? (registro.avancePorcentaje || 0) : null,
            meta: textoMeta,
            sinMeta: !umbrales,
            nivel: nivel,
            cancelado: estaCancelado(registro),
            acciones: typeof opciones.acciones === "function"
                ? (opciones.acciones(registro) || "")
                : "",
            extras: typeof opciones.extras === "function"
                ? (opciones.extras(registro) || "")
                : ""
        };
    }


    /* ── Escribir en el DOM solo lo que cambió ───────────────
       Cada `if` de aquí es una escritura que NO ocurre cuando el
       dato no se movió. En un tablero que se repinta cada minuto
       para recalcular los tiempos, la mayoría de campos son
       idénticos entre pintada y pintada. */
    function pintarTarjeta(tarjeta, nuevo, config) {

        const r = tarjeta.refs;
        const viejo = tarjeta.estado;
        const esNueva = viejo === null;

        // Libre ↔ ocupado: el cambio grande.
        if (esNueva || viejo.ocupado !== nuevo.ocupado) {
            tarjeta.root.classList.toggle("tm-libre", !nuevo.ocupado);
            tarjeta.root.classList.toggle("tm-ocupado-card", nuevo.ocupado);
            r.estado.textContent = nuevo.ocupado ? "OCUPADO" : "LIBRE";
            r.vacio.style.display = nuevo.ocupado ? "none" : "";
            r.ocupado.style.display = nuevo.ocupado ? "" : "none";

            // Las dos escenas del dibujo.
            r.camion.style.display = nuevo.ocupado ? "" : "none";
            r.bahia.style.display = nuevo.ocupado ? "none" : "";

            /* Un camión que acaba de llegar entra rodando; los
               datos, detrás. En la primera pintada no: ahí entra el
               tablero entero en cascada y esto sería movimiento
               sobre movimiento. */
            if (!esNueva && nuevo.ocupado && !primeraPintada) {
                llegarAlMuelle(r.camion);
                aparecer(r.ocupado);
            }
        }

        if (!nuevo.ocupado) {
            pararPulso(tarjeta.root);
            tarjeta.root.classList.remove("nivel-media", "nivel-alta", "tm-cancelado");

            /* Se borra la marca del vehículo que estuvo aquí. Dejarla
               puesta hace que un muelle vacío siga respondiendo al
               clic con la ficha del camión que ya se fue — y en un
               tablero eso no se ve venir, porque la tarjeta dice
               LIBRE. */
            tarjeta.root.removeAttribute("data-vehiculo");

            tarjeta.estado = nuevo;
            return;
        }

        tarjeta.root.setAttribute("data-vehiculo", nuevo.id);

        // Mismo muelle, otro camión. Merece aviso: es lo que
        // distingue "sigue el de antes" de "ya entró el siguiente".
        const cambioDeVehiculo = viejo && viejo.ocupado && viejo.id !== nuevo.id;
        if (cambioDeVehiculo && !primeraPintada) destacarCambio(r.ocupado);

        if (esNueva || viejo.placa !== nuevo.placa) r.placa.textContent = nuevo.placa;
        if (esNueva || viejo.conductor !== nuevo.conductor) r.conductor.textContent = nuevo.conductor;
        if (esNueva || viejo.tipologia !== nuevo.tipologia) r.tipologia.textContent = nuevo.tipologia;

        /* Los extras del panel. Mismo trato que las acciones: se
           reescriben solo cuando su HTML cambia. Aquí importa más
           todavía, porque dentro puede haber un <select> abierto o
           un campo a medio escribir — reescribirlo en cada snapshot
           de la bodega se lo cerraría al supervisor en la cara. */
        if (esNueva || viejo.extras !== nuevo.extras) {
            r.extras.innerHTML = nuevo.extras;
        }

        /* EL REMOLQUE SE LLENA SIEMPRE.

           Va aparte del bloque de texto de abajo a propósito. El
           dibujo es del componente y el widget de avance puede ser
           del panel: donde el supervisor pone el suyo editable
           —`mostrarAvance: false`— el texto se esconde, pero el
           camión tiene que seguir contando la carga. Atarlos daría
           supervisores con el remolque siempre vacío.

           Con el vehículo sin avance que registrar, a cero: el nodo
           es el mismo entre un camión y el siguiente —que es lo que
           permite animarlo— y sin esto conservaría la carga del
           anterior. */
        if (esNueva || viejo.pct !== nuevo.pct || viejo.conAvance !== nuevo.conAvance) {
            llenarRemolque(r.carga, nuevo.conAvance ? nuevo.pct : 0);
        }

        /* El bloque de texto "Cargue · 60%". Se esconde donde el
           panel dibuja el suyo. */
        const avanceDelComponente = opciones.mostrarAvance !== false;

        if (esNueva || viejo.conAvance !== nuevo.conAvance) {
            r.avance.style.display = (nuevo.conAvance && avanceDelComponente) ? "" : "none";
        }

        if (nuevo.conAvance && avanceDelComponente) {
            if (esNueva || viejo.fase !== nuevo.fase) r.fase.textContent = nuevo.fase;
            if (esNueva || viejo.pct !== nuevo.pct) r.pct.textContent = nuevo.pct + "%";
        }

        if (esNueva || viejo.meta !== nuevo.meta) r.meta.textContent = nuevo.meta;

        if (esNueva || viejo.sinMeta !== nuevo.sinMeta) {
            r.meta.classList.toggle("tm-sin-meta", nuevo.sinMeta);
        }

        if (esNueva || viejo.nivel !== nuevo.nivel) {
            tarjeta.root.classList.toggle("nivel-media", nuevo.nivel === "media");
            tarjeta.root.classList.toggle("nivel-alta", nuevo.nivel === "alta");

            // El pulso solo para el que ya se pasó. Si latiera
            // también el que va "en atención", latiría medio
            // tablero media tarde y dejaría de significar algo.
            if (nuevo.nivel === "alta") pulsar(tarjeta.root);
            else pararPulso(tarjeta.root);
        }

        if (esNueva || viejo.cancelado !== nuevo.cancelado) {
            tarjeta.root.classList.toggle("tm-cancelado", nuevo.cancelado);
        }

        /* Los botones se reescriben solo cuando su HTML cambia de
           verdad. Importa: el estado de "Salida" depende del avance,
           así que sin esta comparación se recrearían en cada
           snapshot de la bodega, y un botón recreado bajo el cursor
           pierde el `:hover` y a veces se come el clic. */
        if (esNueva || viejo.acciones !== nuevo.acciones) {
            r.acciones.innerHTML = nuevo.acciones;
        }

        tarjeta.estado = nuevo;
    }


    /*
        Punto de entrada. Se le puede llamar tantas veces como se
        quiera: cada llamada es un diff, no un repintado.

        datos:
            numeros    [1,2,3…] o [9,10,11] — los muelles de esta
                       bodega, ya resueltos con su primer muelle
            registros  los vehículos activos de la bodega
            config     la configuración de la bodega
    */
    function actualizar(datos) {

        datos = datos || {};

        const numeros = datos.numeros || [];
        const registros = datos.registros || [];
        const config = datos.config || null;

        // Qué vehículo hay en cada muelle. Se arma una vez por
        // actualización en vez de recorrer los registros dentro
        // del bucle de muelles.
        const porMuelle = new Map();
        registros.forEach(function (r) {
            if (r.ubicacion === "Muelle" && !r.horaSalida && r.numeroMuelle != null) {
                porMuelle.set(String(r.numeroMuelle), r);
            }
        });

        // Muelles que ya no existen (el administrador bajó el
        // número en la configuración).
        const vigentes = new Set(numeros.map(String));
        tarjetas.forEach(function (tarjeta, clave) {
            if (vigentes.has(clave)) return;
            pararPulso(tarjeta.root);
            tarjetas.delete(clave);
            desaparecer(tarjeta.root, function () {
                if (tarjeta.root.parentNode) tarjeta.root.parentNode.removeChild(tarjeta.root);
            });
        });

        const reciennacidas = [];

        numeros.forEach(function (numero) {

            const clave = String(numero);
            let tarjeta = tarjetas.get(clave);

            if (!tarjeta) {
                tarjeta = construirTarjeta(numero);
                tarjetas.set(clave, tarjeta);
                contenedor.appendChild(tarjeta.root);
                reciennacidas.push(tarjeta.root);
            }

            pintarTarjeta(tarjeta, leerMuelle(porMuelle.get(clave), config), config);
        });

        if (reciennacidas.length) aparecerEnCascada(reciennacidas);

        primeraPintada = false;
    }


    /* Rótulo del segundo campo según la bodega: en J4 no es un
       conductor, es un proveedor. Se expone para que el tablero
       pueda titular bien sin volver a importar config. */
    function rotuloConductor(config) {
        return etiquetaCampo(config, "conductor");
    }


    function destruir() {
        tarjetas.forEach(function (t) { pararPulso(t.root); });
        tarjetas.clear();
        if (typeof opciones.onSeleccion === "function") {
            contenedor.removeEventListener("click", alHacerClic);
        }
        contenedor.innerHTML = "";
    }


    return {
        actualizar: actualizar,
        rotuloConductor: rotuloConductor,
        destruir: destruir
    };
}


/* Cuántos muelles están ocupados ahora. Lo usan los KPI del
   tablero; vive aquí porque es la misma pregunta que responde la
   grilla y no tiene sentido contarlo con otra regla. */
export function contarOcupados(registros, numeros) {
    const vigentes = new Set((numeros || []).map(String));
    const ocupados = new Set();
    (registros || []).forEach(function (r) {
        if (r.ubicacion === "Muelle" && !r.horaSalida && r.numeroMuelle != null &&
            vigentes.has(String(r.numeroMuelle))) {
            ocupados.add(String(r.numeroMuelle));
        }
    });
    return ocupados.size;
}
