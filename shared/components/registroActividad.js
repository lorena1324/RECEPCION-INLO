/* =========================================================
   INLOTRANS — Registro de actividad en vivo (componente)

   La franja de "qué acaba de pasar en la bodega" del tablero.

   No es una colección nueva ni una consulta aparte: se arma con
   el `historial` que cada vehículo ya trae consigo. Todo lo que
   la portería y el supervisor hacen —registrar una entrada, mover
   un vehículo a muelle, dejar una novedad, subir el avance,
   autorizar una salida, cancelar— queda apilado ahí. Lo único que
   falta es leerlo al revés: en vez de "qué le ha pasado a este
   camión", "qué ha pasado en la bodega".

   Por eso el componente no habla con Firestore. Recibe los mismos
   registros que ya tiene el tablero y los reordena. Cero lecturas
   extra, cero costo adicional.

   ── LA IDENTIDAD DE UNA LÍNEA ──

   Igual que en el tablero de muelles, aquí nada se repinta con
   innerHTML: cada línea es un nodo que se queda. Para saber si
   una línea ya estaba hay que poder identificarla, y las entradas
   del historial no traen id propio. Se compone una clave con el
   vehículo, la marca de tiempo, el tipo y su posición dentro de
   su propio historial, que es único en la práctica.

   Sin esa clave, cada actualización volvería a animar las veinte
   líneas como si todas fueran nuevas, y el tablero parecería una
   máquina tragamonedas.

   ── POR QUÉ SE REORDENA CON CUIDADO ──

   Insertar cada línea al principio en cada actualización da el
   orden correcto y es un error: mueve nodos que ya estaban en su
   sitio, y mover un nodo interrumpe la transición que tuviera en
   curso. El bucle de `actualizar()` compara contra el hermano que
   debería tener y solo toca las que están fuera de lugar — que en
   el caso normal (una línea nueva arriba) es exactamente una.
   ========================================================= */

import { getHistorial, tituloHistorial } from "../services/eventos.js";
import { aparecer } from "./animaciones.js";


/* Cuántas líneas caben antes de que la franja deje de ser un
   vistazo y pase a ser una tabla que nadie lee de lejos. */
const MAXIMO_POR_DEFECTO = 12;


/* Icono por tipo de evento. `ti-point` es el que se usa cuando
   aparezca un tipo que este componente todavía no conoce: un
   evento con icono genérico es preferible a un hueco. */
const ICONOS = {
    entrada: "ti-login",
    ubicacion: "ti-arrows-exchange",
    observacion: "ti-message-2",
    avance: "ti-progress",
    autorizacion: "ti-shield-check",
    salida: "ti-logout",
    cancelacion: "ti-ban",
    correccion: "ti-edit"
};


/* Solo la hora. La franja muestra lo que está pasando ahora; la
   fecha completa en cada línea sería repetir veinte veces el día
   de hoy. */
function soloHora(iso) {
    if (!iso || typeof iso !== "string") return "--:--";
    const t = iso.indexOf("T");
    return t === -1 ? "--:--" : iso.slice(t + 1, t + 6);
}


function claveDe(placa, item, indice) {
    return [placa, item.fecha || "", item.tipo || "", indice].join("|");
}


/*
    Crea la franja dentro de `contenedor`.

    opciones:
        maximo   cuántas líneas se conservan (por defecto 12)
*/
export function crearRegistroActividad(contenedor, opciones) {

    opciones = opciones || {};
    const maximo = opciones.maximo || MAXIMO_POR_DEFECTO;

    /* clave → nodo. Es lo que permite saber qué línea ya estaba
       en pantalla y cuál acaba de ocurrir. */
    const lineas = new Map();

    let primeraPintada = true;

    /* Las filas van en su propia lista y el aviso de vacío queda
       fuera de ella. Si compartieran padre, el "primer hijo" del
       contenedor unas veces sería una fila y otras el aviso, y
       toda la lógica de orden de abajo tendría que andar
       esquivándolo. */
    const lista = document.createElement("div");
    lista.className = "ra-lista";

    const vacio = document.createElement("div");
    vacio.className = "ra-vacio";
    vacio.textContent = "Sin movimientos todavía en este turno.";

    contenedor.appendChild(lista);
    contenedor.appendChild(vacio);


    function construirLinea(evento) {

        const fila = document.createElement("div");
        fila.className = "ra-fila ra-" + (evento.tipo || "otro");

        const hora = document.createElement("span");
        hora.className = "ra-hora";
        hora.textContent = soloHora(evento.fecha);

        const icono = document.createElement("i");
        icono.className = "ti " + (ICONOS[evento.tipo] || "ti-point");

        const placa = document.createElement("span");
        placa.className = "ra-placa";
        placa.textContent = evento.placa;

        const texto = document.createElement("span");
        texto.className = "ra-texto";
        texto.textContent = evento.titulo;

        const quien = document.createElement("span");
        quien.className = "ra-quien";
        quien.textContent = evento.operador || "";

        fila.appendChild(hora);
        fila.appendChild(icono);
        fila.appendChild(placa);
        fila.appendChild(texto);
        fila.appendChild(quien);

        return fila;
    }


    /*
        Aplana el historial de todos los vehículos en una sola
        lista ordenada de más reciente a más antiguo.

        Se recorta a `maximo` ANTES de tocar el DOM: con doscientos
        vehículos en el día, el historial completo son miles de
        entradas y de esas solo se van a ver doce.
    */
    function aplanar(registros) {

        const todos = [];

        (registros || []).forEach(function (r) {
            const historial = getHistorial(r) || [];
            historial.forEach(function (item, i) {
                todos.push({
                    clave: claveDe(r.placa, item, i),
                    fecha: item.fecha,
                    tipo: item.tipo,
                    operador: item.operador,
                    placa: r.placa || "—",
                    titulo: tituloHistorial(item)
                });
            });
        });

        // Orden descendente por fecha ISO. Comparar las cadenas
        // funciona porque el formato es "YYYY-MM-DDTHH:MM" y no
        // cuesta construir un Date por cada entrada.
        todos.sort(function (a, b) {
            return (b.fecha || "").localeCompare(a.fecha || "");
        });

        return todos.slice(0, maximo);
    }


    function actualizar(registros) {

        const eventos = aplanar(registros);

        vacio.style.display = eventos.length ? "none" : "";

        const vigentes = new Set(eventos.map(function (e) { return e.clave; }));

        // Fuera las que se cayeron del corte.
        lineas.forEach(function (nodo, clave) {
            if (vigentes.has(clave)) return;
            if (nodo.parentNode) nodo.parentNode.removeChild(nodo);
            lineas.delete(clave);
        });

        const nuevas = [];

        /* Un solo recorrido de arriba abajo. `anterior` es la
           línea que debería quedar justo encima de la actual; si
           la que hay en esa posición ya es la correcta, no se
           toca nada. En el caso normal —una entrada nueva y el
           resto igual— esto mueve un nodo y deja los otros once
           donde estaban, con sus transiciones intactas. */
        let anterior = null;

        for (let i = 0; i < eventos.length; i++) {

            const evento = eventos[i];
            let nodo = lineas.get(evento.clave);
            const esNueva = !nodo;

            if (esNueva) {
                nodo = construirLinea(evento);
                lineas.set(evento.clave, nodo);
                nuevas.push(nodo);
            }

            const enSuSitio = anterior ? anterior.nextSibling : lista.firstChild;
            if (nodo !== enSuSitio) lista.insertBefore(nodo, enSuSitio);

            anterior = nodo;
        }

        /* Se anima DESPUÉS de colocar. Animar en el momento de
           crear y mover el nodo a continuación cortaría la
           animación recién empezada.

           En la primera pintada no se anima nada: al abrir el
           tablero todo es "nuevo" y animar doce líneas de historia
           vieja daría la impresión de que acaba de ocurrir todo a
           la vez. */
        if (!primeraPintada) {
            nuevas.forEach(function (nodo) { aparecer(nodo, { desde: -10 }); });
        }

        primeraPintada = false;
    }


    function destruir() {
        lineas.clear();
        lista.innerHTML = "";
    }


    return {
        actualizar: actualizar,
        destruir: destruir
    };
}
