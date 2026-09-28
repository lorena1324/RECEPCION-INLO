/* =========================================================
   INLOTRANS — Motor de animación

   Envoltura sobre anime.js para todo el proyecto. Existe por
   tres razones, y ninguna es "para no escribir el import dos
   veces":

   1. LA PANTALLA NO SE PUEDE CAER POR UNA ANIMACIÓN.

      El tablero de portería vive encendido todo el turno en un
      televisor que nadie está mirando de cerca. anime.js llega
      por CDN, y un CDN se cae, o la bodega se queda sin salida
      a internet un rato. Si el tablero dependiera de que ese
      import responda, un hipo de red dejaría la pantalla en
      blanco y la portería sin saber qué muelle está libre.

      Por eso aquí TODO degrada a no-op: si anime.js no carga,
      no hay movimiento y el tablero se ve exactamente igual,
      solo que estático. Nunca menos información, nunca una
      pantalla vacía.

   2. EL ESTADO FINAL NO PUEDE DEPENDER DE LA ANIMACIÓN.

      La forma habitual de animar una entrada —dejar el elemento
      en opacity:0 por CSS y subirlo a 1 con JS— es exactamente
      la trampa anterior: si el JS no corre, el elemento existe,
      ocupa su sitio y es invisible para siempre.

      Aquí es al revés. El CSS deja todo visible y en su sitio;
      es el JS el que, SOLO si el motor cargó, retrocede el
      elemento a su estado inicial justo antes de animarlo. Sin
      motor no hay retroceso, y por tanto no hay nada que pueda
      quedarse a medias.

   3. EL MOVIMIENTO EN UNA PANTALLA DE TURNO SE VUELVE RUIDO.

      Lo que se repite cada treinta segundos delante de alguien
      que lleva ocho horas ahí deja de informar y empieza a
      molestar. Las duraciones de abajo son deliberadamente
      cortas y están en un solo sitio para poder bajarlas todas
      de una vez. Y `prefers-reduced-motion` se respeta sin
      discutir: quien lo activó tiene una razón.
   ========================================================= */

/* Versión fija, no un rango. Un `@latest` en una pantalla de
   producción significa que una mañana cualquiera el tablero
   amanece con otra librería sin que nadie haya desplegado nada. */
const CDN_ANIME = "https://cdn.jsdelivr.net/npm/animejs@4.5.0/+esm";

/* Duraciones en milisegundos. Un solo sitio a propósito: cuando
   el tablero lleve un mes colgado y el equipo pida "menos
   movimiento", se bajan aquí y baja en todas partes. */
export const TIEMPOS = {
    entrada: 420,
    salida: 260,
    cambio: 320,
    contador: 650,
    pulso: 1100
};

/* El retardo entre una tarjeta y la siguiente en una cascada.
   Con ocho muelles, 45ms da una barrida que se lee como una sola
   pasada; más que eso y la última tarjeta llega tarde. */
export const CASCADA = 45;

let motor = null;      // el módulo de anime.js, o null si no hay
let cargando = null;   // la promesa en vuelo, para no pedirlo dos veces


/* Quien pidió menos movimiento en su sistema operativo no quiere
   que una pantalla de trabajo se lo ignore. Se consulta en cada
   llamada y no una sola vez al arrancar porque en un televisor de
   bodega la página puede quedarse meses abierta, y el ajuste
   puede cambiar en medio. */
function prefiereQuietud() {
    return typeof window !== "undefined" &&
           typeof window.matchMedia === "function" &&
           window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}


/*
    Carga anime.js una sola vez. Devuelve el módulo, o null si no
    se pudo — y `null` no es un error que haya que atrapar arriba:
    es el modo sin animación, que es un modo válido.

    Se llama al arrancar la página, pero no hace falta esperarla:
    todo lo de abajo funciona (sin moverse) mientras el import
    todavía va en camino.
*/
export function iniciarAnimaciones() {

    if (cargando) return cargando;

    if (prefiereQuietud()) {
        cargando = Promise.resolve(null);
        return cargando;
    }

    cargando = import(/* @vite-ignore */ CDN_ANIME)
        .then(function (mod) {
            motor = mod;
            return mod;
        })
        .catch(function (error) {
            // Aviso, no excepción: el tablero sigue sirviendo sin esto.
            console.warn("[animaciones] anime.js no cargó; el tablero queda estático.", error);
            motor = null;
            return null;
        });

    return cargando;
}


/* Si hay movimiento disponible ahora mismo. Lo usan los
   componentes para decidir si vale la pena preparar un estado
   inicial: sin motor, ni se toca el DOM. */
export function hayMovimiento() {
    return motor !== null && !prefiereQuietud();
}


/*
    Entrada en cascada de un grupo de elementos (las tarjetas de
    muelle al abrir el tablero, las filas nuevas del registro).

    Nótese el orden: primero se comprueba el motor, y solo
    entonces se empujan los elementos a su estado inicial. Al
    revés —empujarlos y después descubrir que no hay motor— es
    justamente cómo se deja una pantalla en blanco.
*/
export function aparecerEnCascada(elementos, opciones) {

    var lista = Array.prototype.slice.call(elementos || []);
    if (!lista.length || !hayMovimiento()) return;

    opciones = opciones || {};

    motor.animate(lista, {
        opacity: [0, 1],
        translateY: [opciones.desde != null ? opciones.desde : 10, 0],
        duration: opciones.duracion || TIEMPOS.entrada,
        delay: motor.stagger(opciones.cascada || CASCADA),
        ease: "out(3)"
    });
}


/*
    Aparición de un elemento suelto: un vehículo que acaba de
    entrar a un muelle que estaba libre.
*/
export function aparecer(el, opciones) {

    if (!el || !hayMovimiento()) return;

    opciones = opciones || {};

    motor.animate(el, {
        opacity: [0, 1],
        translateY: [opciones.desde != null ? opciones.desde : 8, 0],
        duration: opciones.duracion || TIEMPOS.entrada,
        ease: "out(3)"
    });
}


/*
    Un vehículo que llega al muelle: entra rodando desde la
    derecha, que es por donde entran de verdad —la tarjeta dibuja
    el muelle a la izquierda y el camión retrocediendo hacia él—.

    Va con rebote corto al final (`out(4)`) porque un camión que
    frena no se detiene en seco. Es el único sitio del proyecto con
    una entrada tan marcada, y se lo puede permitir porque pasa una
    vez por vehículo, no en cada actualización.
*/
export function llegarAlMuelle(el, opciones) {

    if (!el || !hayMovimiento()) return;

    opciones = opciones || {};

    motor.animate(el, {
        opacity: [0, 1],
        translateX: [opciones.desde != null ? opciones.desde : 42, 0],
        duration: opciones.duracion || 560,
        ease: "out(4)"
    });
}


/*
    Cambio de contenido en sitio: el muelle sigue ocupado pero
    ahora es otro vehículo, o el mismo cambió de estado.

    Es un parpadeo corto y no una salida-entrada completa: la
    tarjeta no se va a ninguna parte, solo avisa de que lo que
    dice cambió.
*/
export function destacarCambio(el) {

    if (!el || !hayMovimiento()) return;

    motor.animate(el, {
        opacity: [0.35, 1],
        duration: TIEMPOS.cambio,
        ease: "out(2)"
    });
}


/*
    Cuenta un número de donde está a donde va.

    El fallback importa más de lo que parece: si no hay motor,
    el valor se escribe directo. Un KPI que se queda en el número
    viejo porque la animación no corrió es peor que uno que nunca
    se animó — estaría mintiendo.

    ── DE DÓNDE SALE "DONDE ESTÁ" ──

    Del propio nodo, guardado aparte, y NO de leer su texto. Leer
    el texto y quitarle lo que no sea dígito parece equivalente y
    no lo es: un KPI formateado como "3 / 8" se lee como treinta y
    ocho, y el contador arranca desde ahí y baja. Con `formato` de
    por medio, el texto en pantalla no tiene por qué ser el número
    y no se puede deducir de vuelta.
*/
export function contarHasta(el, valor, opciones) {

    if (!el) return;

    opciones = opciones || {};
    var destino = Number(valor) || 0;
    var formato = opciones.formato || function (n) { return String(Math.round(n)); };

    var actual = typeof el.__valor === "number" ? el.__valor : 0;
    el.__valor = destino;

    if (!hayMovimiento()) {
        el.textContent = formato(destino);
        return;
    }

    // Sin cambio no hay nada que contar. Repintar el mismo número
    // con una animación de medio segundo es movimiento vacío.
    if (actual === destino) {
        el.textContent = formato(destino);
        return;
    }

    var cursor = { v: actual };

    motor.animate(cursor, {
        v: destino,
        duration: opciones.duracion || TIEMPOS.contador,
        ease: "out(3)",
        onUpdate: function () { el.textContent = formato(cursor.v); },
        // El onComplete no es redundante: garantiza el valor exacto
        // aunque el último frame se pierda por un tirón del equipo.
        onComplete: function () { el.textContent = formato(destino); }
    });
}


/*
    Pulso de atención sostenido: un vehículo que se pasó de su
    meta de muelle.

    Se guarda la animación en el propio elemento para poder
    pararla cuando el muelle vuelva a la normalidad. Sin esa
    referencia quedarían pulsos huérfanos latiendo sobre
    tarjetas que ya están en verde.
*/
export function pulsar(el) {

    if (!el || !hayMovimiento()) return;
    if (el.__pulso) return;                 // ya está latiendo

    el.__pulso = motor.animate(el, {
        opacity: [1, 0.55],
        duration: TIEMPOS.pulso,
        ease: "inOut(2)",
        loop: true,
        alternate: true
    });
}


export function pararPulso(el) {

    if (!el || !el.__pulso) return;

    if (typeof el.__pulso.pause === "function") el.__pulso.pause();
    el.__pulso = null;

    // Se devuelve a mano al estado bueno: la animación puede
    // haberse detenido en cualquier punto del ciclo, y dejarla
    // ahí sería un elemento a media opacidad para siempre.
    el.style.opacity = "";
}


/*
    Salida de un elemento que deja de existir (un muelle que se
    quitó de la configuración).

    `despues` se llama SIEMPRE, con motor o sin él. Es quien
    quita el nodo del DOM, así que si dependiera de la animación
    una pantalla sin anime.js acumularía tarjetas fantasma.
*/
export function desaparecer(el, despues) {

    var terminar = typeof despues === "function" ? despues : function () {};

    if (!el || !hayMovimiento()) {
        terminar();
        return;
    }

    motor.animate(el, {
        opacity: [1, 0],
        translateY: [0, -8],
        duration: TIEMPOS.salida,
        ease: "in(2)",
        onComplete: terminar
    });
}
