/* =========================================================
   INLOTRANS
   Escala de lo que se lee en pantalla completa

   Los textos del tablero tienen un tamaño fijo en píxeles, pensado
   para un monitor de escritorio. En un televisor visto desde varios
   metros (p. ej. 50" a casi 4 m de altura) hay que agrandarlos en
   proporción a la altura de la pantalla: 1 hasta ~760 px de alto,
   ~1,4 en 1080p, ~2,4 como tope.
   ========================================================= */

import { useEffect, useState } from "react";

const BASE = 760;
const TOPE = 2.4;

function calcular() {
    if (typeof window === "undefined") return 1;
    return Math.min(TOPE, Math.max(1, Math.round((window.innerHeight / BASE) * 100) / 100));
}

export function usarEscalaPantalla(activo) {

    const [escala, setEscala] = useState(calcular);

    useEffect(() => {
        if (!activo) return;
        const medir = () => setEscala(calcular());
        medir();
        window.addEventListener("resize", medir);
        return () => window.removeEventListener("resize", medir);
    }, [activo]);

    return activo ? escala : 1;
}
