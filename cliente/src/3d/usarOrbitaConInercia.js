/* =========================================================
   INLOTRANS
   Giro de cámara con inercia

   Adaptación del ejemplo "Three.js OrbitControls" de Motion
   (motion.dev/examples/js-three-orbit) a React Three Fiber:

     - OrbitControls hace todo el trabajo del mouse/dedo.
     - Motion solo pone la velocidad de giro automático. Al
       soltar un arrastre, la cámara conserva la velocidad con
       que se la soltó y frena suave hasta el giro lento normal.

   Requiere <OrbitControls makeDefault enableDamping={false} />:
   con el amortiguado propio de OrbitControls las dos inercias
   se pelearían.
   ========================================================= */

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { animate, motionValue } from "motion";

const VELOCIDAD_BASE = 0.06;   // rad/s
const VELOCIDAD_MAXIMA = 2.4;  // tope al soltar un arrastre fuerte

export function usarOrbitaConInercia({ activo = true, pausado = false } = {}) {

    const controles = useThree((s) => s.controls);
    const giro = useRef(null);

    useEffect(() => {

        if (!controles) return;

        // Ángulo "desenrollado": sin el salto de 2π al dar la
        // vuelta, si no la velocidad medida sería enorme en ese
        // cuadro.
        const angulo = motionValue(controles.getAzimuthalAngle());
        const velocidad = motionValue(VELOCIDAD_BASE);
        let anterior = controles.getAzimuthalAngle();
        let acumulado = anterior;
        let arrastrando = false;
        let frenado;

        function medir() {
            const actual = controles.getAzimuthalAngle();
            let cambio = actual - anterior;
            if (cambio > Math.PI) cambio -= Math.PI * 2;
            if (cambio < -Math.PI) cambio += Math.PI * 2;
            acumulado += cambio;
            anterior = actual;
            angulo.set(acumulado);
        }

        function alEmpezar() {
            arrastrando = true;
            frenado?.stop();
            medir();
        }

        function alTerminar() {
            arrastrando = false;
            const soltado = Math.max(-VELOCIDAD_MAXIMA, Math.min(VELOCIDAD_MAXIMA, angulo.getVelocity()));
            velocidad.set(soltado);
            frenado = animate(velocidad, VELOCIDAD_BASE, { duration: 2.4, ease: [0.16, 1, 0.3, 1] });
        }

        controles.addEventListener("start", alEmpezar);
        controles.addEventListener("end", alTerminar);

        giro.current = { medir, velocidad, arrastrando: () => arrastrando };

        return () => {
            frenado?.stop();
            controles.removeEventListener("start", alEmpezar);
            controles.removeEventListener("end", alTerminar);
            giro.current = null;
        };

    }, [controles]);

    useFrame((_, delta) => {

        const g = giro.current;
        if (!g) return;

        if (activo && !pausado && !g.arrastrando()) {
            const segundos = Math.min(delta, 0.05);
            controles.setAzimuthalAngle(controles.getAzimuthalAngle() + g.velocidad.get() * segundos);
        }

        g.medir();
    });
}
