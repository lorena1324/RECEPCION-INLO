/* =========================================================
   INLOTRANS
   Punto de entrada del motor 3D (se compila a
   shared/vendor/muelles3d/muelles3d.js)

   montarMuelles3D(host, acciones) crea un Shadow DOM dentro de
   `host`, monta ahí la escena y devuelve:

       actualizar(parcial)  mezcla datos nuevos y repinta
       destruir()

   El estado vive en un almacén mínimo (no en React) para que
   la página lo alimente con llamadas sueltas, igual que hoy
   alimenta al tablero de siempre.
   ========================================================= */

import { createRoot } from "react-dom/client";

import MotorMuelles from "./MotorMuelles.jsx";
import estilos from "./estilos.css?inline";

/*
    Tailwind declara sus variables internas con @property, y
    @property no funciona dentro de un Shadow DOM: sin valor
    inicial, utilidades como `border` o `shadow-lg` quedarían sin
    efecto. Tailwind ya trae esos valores iniciales en un bloque
    de respaldo para navegadores viejos, encerrado en un
    @supports; aquí se abre ese bloque para todos.
*/
function css() {
    return estilos.replace(/@supports\s*\(\(\(-webkit-hyphens:\s*none\)\)[^{]*\{/, "@supports (display:block){");
}

function crearAlmacen(inicial) {
    let estado = inicial;
    const oyentes = new Set();
    return {
        leer: () => estado,
        suscribir: (fn) => { oyentes.add(fn); return () => oyentes.delete(fn); },
        mezclar: (parcial) => { estado = { ...estado, ...parcial }; oyentes.forEach((fn) => fn()); }
    };
}

export function montarMuelles3D(host, acciones) {

    const sombra = host.shadowRoot || host.attachShadow({ mode: "open" });

    const estilo = document.createElement("style");
    estilo.textContent = css();
    const raiz = document.createElement("div");
    raiz.style.height = "100%";
    sombra.replaceChildren(estilo, raiz);

    const almacen = crearAlmacen({
        titulo: "Muelles",
        nombreBodega: "CENTRO DE DISTRIBUCIÓN",
        muelles: [],
        patio: [],
        salientes: [],
        seleccionado: null,
        seleccionadoPatio: null,
        animarLlegada: false,
        expandido: false,
        hayFicha: false,
        semaforo: null
    });

    const react = createRoot(raiz);
    react.render(<MotorMuelles almacen={almacen} acciones={acciones} />);

    return {
        actualizar: almacen.mezclar,
        destruir() {
            react.unmount();
            sombra.replaceChildren();
        }
    };
}
