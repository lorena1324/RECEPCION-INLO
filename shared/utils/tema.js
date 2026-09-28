/* =========================================================
   INLOTRANS — Claro / oscuro

   El interruptor de tema, compartido por todos los roles que lo
   monten. Los estilos están en css/tema-oscuro.css; esto solo
   decide cuándo se pone el atributo `data-tema` en el <html>.

   ── EL PARPADEO BLANCO ──

   Este archivo NO puede ser el que aplique el tema al cargar la
   página. Es un módulo, y los módulos son diferidos: para cuando
   se ejecuta, el navegador ya pintó la pantalla en claro. En una
   caseta a oscuras, ese fogonazo blanco de medio segundo cada vez
   que alguien recarga es justo lo que hace que la gente apague el
   modo oscuro y no vuelva.

   Por eso el tema se aplica en un script EN LÍNEA en el <head>,
   antes de que exista nada que pintar. Ese script es dos líneas y
   está duplicado en cada página a propósito: es el precio de que
   no haya parpadeo, y no se puede pagar desde un archivo externo.
   `SNIPPET_ANTI_PARPADEO` de abajo es ese texto, aquí para que
   haya un sitio único donde leer qué debe decir.

   ── DÓNDE SE GUARDA ──

   En localStorage, por navegador y por equipo. Es lo correcto
   para esto: el tema es una preferencia del PUESTO, no de la
   persona. El portátil de la caseta puede estar en oscuro toda la
   noche mientras el de la oficina sigue en claro, y quien entre a
   relevar el turno encuentra la pantalla como estaba, sin que su
   perfil le imponga otra cosa.
   ========================================================= */

const CLAVE = "inlotrans:tema";

const OSCURO = "oscuro";
const CLARO = "claro";


/* El script que cada página debe llevar EN LÍNEA en su <head>,
   antes de los <link>. Se exporta como texto para que quede un
   único sitio donde consultar qué tiene que decir; copiarlo es
   deliberado (ver arriba). */
export const SNIPPET_ANTI_PARPADEO =
    'try{var t=localStorage.getItem("' + CLAVE + '");' +
    'if(t==="' + OSCURO + '")document.documentElement.setAttribute("data-tema","' + OSCURO + '");}catch(e){}';


/*
    Lee la preferencia guardada.

    Todo va envuelto en try/catch porque localStorage lanza —no
    devuelve null, LANZA— en navegación privada y con las cookies
    de sitio bloqueadas. Una excepción aquí, en el arranque de la
    página, dejaría el panel entero sin cargar por no poder leer
    un color.
*/
export function temaGuardado() {
    try {
        return localStorage.getItem(CLAVE) === OSCURO ? OSCURO : CLARO;
    } catch (e) {
        return CLARO;
    }
}


export function esOscuro() {
    return document.documentElement.getAttribute("data-tema") === OSCURO;
}


export function aplicarTema(tema) {

    if (tema === OSCURO) {
        document.documentElement.setAttribute("data-tema", OSCURO);
    } else {
        document.documentElement.removeAttribute("data-tema");
    }

    try {
        localStorage.setItem(CLAVE, tema);
    } catch (e) {
        // Sin poder guardar, el tema vale para esta sesión y se
        // pierde al recargar. Es degradar, no fallar.
    }
}


export function alternarTema() {
    const siguiente = esOscuro() ? CLARO : OSCURO;
    aplicarTema(siguiente);
    return siguiente;
}


/*
    Monta el botón: le pone el icono y el rótulo que tocan y lo
    deja escuchando.

    El icono es el del tema al que se VA, no el del que se está:
    un botón que muestra una luna cuando ya estás en oscuro se lee
    como "estás en modo luna" y la mitad de la gente lo interpreta
    al revés. Con el rótulo pasa lo mismo, y por eso dice "Modo
    claro" cuando la pantalla está oscura.
*/
export function conectarBotonTema(boton) {

    if (!boton) return;

    function pintar() {
        const oscuro = esOscuro();
        const icono = boton.querySelector("i");
        if (icono) icono.className = "ti " + (oscuro ? "ti-sun" : "ti-moon");
        const destino = oscuro ? "Modo claro" : "Modo oscuro";
        boton.setAttribute("title", destino);
        boton.setAttribute("aria-label", destino);
    }

    boton.addEventListener("click", function () {
        alternarTema();
        pintar();
    });

    /* El atributo ya lo puso el script en línea del <head>. Esto
       solo sincroniza el botón con lo que hay: volver a aplicar el
       tema aquí sería repetir un trabajo ya hecho y arriesgarse a
       un segundo repintado. */
    pintar();
}
