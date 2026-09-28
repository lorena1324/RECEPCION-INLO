/* =========================================================
   INLOTRANS — Enviar con Enter

   Lo que ya hacía el login —escribir y darle a Enter sin buscar
   el botón— para el resto de la aplicación.

   No es comodidad: la portería registra vehículos con el camión
   esperando en la fila, muchas veces con una mano en el teclado y
   la otra en la radio. Obligar a soltar el teclado, buscar el
   ratón y apuntar a un botón en cada entrada son segundos por
   camión y decenas de camiones al día.

   ── POR QUÉ NO SE USA <form> COMO EN EL LOGIN ──

   El login tiene un <form> de verdad y le basta con
   `requestSubmit()`. Los diez paneles no: sus formularios son
   rejillas de <div> con un botón y su manejador de clic, y
   envolverlos en <form> ahora significaría tocar diez HTML y
   arriesgarse a recargas de página por un submit que se escape.
   Este archivo da el mismo comportamiento sin cambiar la
   estructura de nada.

   ── CÓMO SABE QUÉ BOTÓN PULSAR ──

   Por convención y sin configurar nada en la mayoría de casos:

     · Dentro de un modal abierto (.modal-backdrop.open), el botón
       primario de su pie (.modal-footer .btn-primary /
       .btn-primario). Los modales ya se escriben así en los diez
       paneles.

     · Fuera de un modal, el contenedor más cercano que lleve
       `data-enter="id-del-boton"`. Es explícito a propósito: una
       vista puede tener varios bloques con botón, y adivinar cuál
       es "el principal" en esa situación es como se acaba
       registrando una entrada al filtrar una tabla.

   ── LO QUE NUNCA DISPARA ──

   Un <textarea>, porque ahí Enter es un salto de línea y esos
   campos son los motivos y las observaciones — justo donde la
   gente escribe varias líneas.

   Un <button> o un <a> con el foco puesto, porque el navegador ya
   los pulsa solo. Sin esta salvedad, tener el foco en "Cancelar" y
   darle a Enter cancelaría Y confirmaría a la vez.

   Un botón deshabilitado, que es como cada panel marca "estoy
   guardando". Es lo que impide que dos Enter seguidos registren
   el vehículo dos veces.
   ========================================================= */


/* Campos donde Enter significa otra cosa y no hay que tocar. */
function esCampoMultilinea(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    // Un editor enriquecido, si algún día entra alguno.
    return el.isContentEditable === true;
}

/* El navegador ya activa los botones y enlaces con el foco
   puesto; duplicarlo dispararía dos acciones con una tecla. */
function yaLoManejaElNavegador(el) {
    if (!el) return false;
    const t = el.tagName;
    return t === "BUTTON" || t === "A";
}


function botonUtilizable(boton) {
    return !!boton && !boton.disabled && boton.offsetParent !== null;
}


/*
    Activa el envío con Enter en toda la página.

    Se llama una vez por panel. Escucha en el documento y no en
    cada campo: los formularios se repintan y los modales nacen y
    mueren, y volver a enganchar oyentes en cada pintada es como
    se acumulan escuchas duplicadas que acaban registrando dos
    veces el mismo vehículo.
*/
export function activarEnvioConEnter() {

    document.addEventListener("keydown", function (evento) {

        if (evento.key !== "Enter") return;

        /* Tecla mantenida. El navegador manda una ráfaga de eventos
           y cada uno pulsaría el botón: con la mano apoyada sin
           querer sobre Enter, eso son treinta vehículos registrados
           en dos segundos. Solo cuenta la primera pulsación. */
        if (evento.repeat) return;

        /* Mientras se compone un carácter con teclado de acentos o
           IME, Enter confirma la composición y no es un envío. */
        if (evento.isComposing || evento.keyCode === 229) return;

        // Enter con Shift/Alt/Ctrl es otra intención, no enviar.
        if (evento.shiftKey || evento.altKey || evento.ctrlKey || evento.metaKey) return;

        const origen = evento.target;
        if (esCampoMultilinea(origen)) return;
        if (yaLoManejaElNavegador(origen)) return;

        const boton = botonDestino(origen);
        if (!botonUtilizable(boton)) return;

        evento.preventDefault();
        boton.click();
    });
}


/*
    Qué botón corresponde al sitio desde donde se pulsó Enter.

    El modal manda sobre el formulario de detrás: si hay uno
    abierto, lo que el operario está llenando es el modal, aunque
    el formulario de la vista siga montado debajo.
*/
function botonDestino(origen) {

    if (!origen || typeof origen.closest !== "function") return null;

    const modal = origen.closest(".modal-backdrop.open");
    if (modal) {
        return modal.querySelector(
            ".modal-footer .btn-primary, .modal-footer .btn-primario"
        );
    }

    /* Fuera de un modal hay que estar DENTRO de un bloque que se
       haya declarado como formulario. Sin esta condición, un Enter
       en el buscador de la tabla de registros dispararía el alta
       del vehículo que hubiera a medio llenar en otra vista. */
    const contenedor = origen.closest("[data-enter]");
    if (!contenedor) return null;

    const id = contenedor.getAttribute("data-enter");
    return id ? document.getElementById(id) : null;
}
