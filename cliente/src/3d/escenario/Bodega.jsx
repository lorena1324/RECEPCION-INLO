/* =========================================================
   INLOTRANS
   Bodega: fachada de muelles, patio e interior en corte

   Aquí van el patio y los muelles (puertas); la nave por dentro
   y por fuera está en Nave.jsx. El techo no se dibuja a
   propósito (vista en corte): desde la cámara del tablero se ve
   la estantería adentro, como en una maqueta.
   ========================================================= */

import { useEffect, useMemo, useRef } from "react";
import { animate } from "motion";

import {
    relievePuertaSeccional, repetir,
    texturaAsfalto, texturaConcreto, texturaFranjas, texturaTexto
} from "../texturas.js";
import {
    LARGO_CUPO, MUELLE, SEPARACION_PATIO, Z_PATIO,
    anchoBodega, cuposPatio, xDeCupo, xDeMuelle
} from "./medidas.js";
import Edificio from "./Nave.jsx";

const { anchoPuerta, altoPuerta, alturaAnden } = MUELLE;


/* ---------------------------------------------------------
   PATIO
   --------------------------------------------------------- */

function Patio({ total, nombresMuelle }) {

    const ancho = anchoBodega(total);
    const asfalto = useMemo(() => repetir(texturaAsfalto(), 24, 16), []);
    const concreto = useMemo(() => repetir(texturaConcreto(), ancho / 4, 4), [ancho]);

    // Las líneas van entre muelles: n + 1 líneas para n bahías.
    const lineas = Array.from({ length: total + 1 }, (_, i) => xDeMuelle(i, total) - MUELLE.separacion / 2);

    return (
        <group>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 40]} receiveShadow>
                <planeGeometry args={[240, 160]} />
                <meshStandardMaterial map={asfalto} roughness={0.95} />
            </mesh>

            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 8]} receiveShadow>
                <planeGeometry args={[ancho, 16]} />
                <meshStandardMaterial map={concreto} roughness={0.9} />
            </mesh>

            {lineas.map((x) => (
                <mesh key={x} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.012, 12]} receiveShadow>
                    <planeGeometry args={[0.15, 22]} />
                    <meshStandardMaterial color="#e8b923" roughness={0.7} />
                </mesh>
            ))}

            <ZonaPatio total={total} />

            {/* Línea de pare y número pintado de cada bahía */}
            {nombresMuelle.map((nombre, i) => (
                <group key={nombre} position={[xDeMuelle(i, total), 0.013, 0]}>
                    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 23]}>
                        <planeGeometry args={[MUELLE.separacion - 0.4, 0.3]} />
                        <meshStandardMaterial color="#e9ecef" roughness={0.7} />
                    </mesh>
                    <NumeroPintado texto={nombre} />
                </group>
            ))}
        </group>
    );
}

/* La fila de cupos donde esperan los vehículos en patio: líneas
   blancas entre cupos, el número de cada uno al pie y el rótulo
   PATIO pintado al costado. */
function ZonaPatio({ total }) {

    const cupos = cuposPatio(total);
    const ancho = cupos * SEPARACION_PATIO;
    const lineas = Array.from({ length: cupos + 1 }, (_, i) => xDeCupo(i, total) - SEPARACION_PATIO / 2);
    const rotulo = useMemo(() => texturaTexto("PATIO", { ancho: 1024, alto: 256, color: "#e9ecef", tamano: 200 }), []);

    return (
        <group position={[0, 0.012, 0]}>
            {lineas.map((x) => (
                <mesh key={x} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0, Z_PATIO + LARGO_CUPO / 2]}>
                    <planeGeometry args={[0.12, LARGO_CUPO]} />
                    <meshStandardMaterial color="#e9ecef" roughness={0.7} />
                </mesh>
            ))}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, Z_PATIO - 0.4]}>
                <planeGeometry args={[ancho, 0.12]} />
                <meshStandardMaterial color="#e9ecef" roughness={0.7} />
            </mesh>
            {Array.from({ length: cupos }, (_, i) => (
                <NumeroCupo key={i} numero={i + 1} x={xDeCupo(i, total)} />
            ))}
            <mesh rotation={[-Math.PI / 2, 0, -Math.PI / 2]} position={[-ancho / 2 - 3, 0.001, Z_PATIO + LARGO_CUPO / 2]}>
                <planeGeometry args={[10, 2.5]} />
                <meshStandardMaterial map={rotulo} transparent roughness={0.7} depthWrite={false} />
            </mesh>
        </group>
    );
}

function NumeroCupo({ numero, x }) {
    const mapa = useMemo(() => texturaTexto(String(numero), { ancho: 256, alto: 256, color: "#e9ecef", tamano: 180 }), [numero]);
    return (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.001, Z_PATIO + LARGO_CUPO + 1.2]}>
            <planeGeometry args={[1.4, 1.4]} />
            <meshStandardMaterial map={mapa} transparent roughness={0.7} depthWrite={false} />
        </mesh>
    );
}

function NumeroPintado({ texto }) {
    const mapa = useMemo(() => texturaTexto(texto, { ancho: 512, alto: 256, color: "#e8b923", tamano: 190 }), [texto]);
    return (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 25.5]}>
            <planeGeometry args={[2.6, 1.3]} />
            <meshStandardMaterial map={mapa} transparent roughness={0.7} depthWrite={false} />
        </mesh>
    );
}


/* ---------------------------------------------------------
   MUELLE (una puerta)
   --------------------------------------------------------- */

function Muelle({ x, ocupado, colorEstado, seleccionado }) {

    const puerta = useRef();
    const relieve = useMemo(() => repetir(relievePuertaSeccional(), 1, altoPuerta / 2.4), []);
    const franjas = useMemo(() => repetir(texturaFranjas(), 4, 1), []);

    // La puerta sube cuando hay vehículo y baja cuando se va.
    useEffect(() => {
        const c = animate(puerta.current.scale, { y: ocupado ? 0.12 : 1 }, { duration: 1.6, ease: [0.45, 0, 0.2, 1], delay: ocupado ? 1.2 : 0 });
        return () => c.stop();
    }, [ocupado]);

    const yPuerta = alturaAnden + altoPuerta;
    const caucho = "#15171b";

    return (
        <group position={[x, 0, 0]}>

            {/* Vano oscuro (se ve cuando la puerta sube) */}
            <mesh position={[0, alturaAnden + altoPuerta / 2, 0.02]}>
                <planeGeometry args={[anchoPuerta, altoPuerta]} />
                <meshStandardMaterial color="#0c0f14" roughness={1} />
            </mesh>

            {/* Puerta seccional: el grupo cuelga del dintel para que
                escalar en y la "enrolle" hacia arriba */}
            <group ref={puerta} position={[0, yPuerta, 0.06]}>
                <mesh position={[0, -altoPuerta / 2, 0]} castShadow receiveShadow>
                    <boxGeometry args={[anchoPuerta, altoPuerta, 0.06]} />
                    <meshStandardMaterial color="#e4e7eb" roughness={0.45} metalness={0.3} bumpMap={relieve} bumpScale={3} />
                </mesh>
            </group>

            {/* Abrigo de caucho alrededor del vano */}
            <mesh position={[0, yPuerta + 0.28, 0.32]} castShadow>
                <boxGeometry args={[anchoPuerta + 0.8, 0.56, 0.6]} />
                <meshStandardMaterial color={caucho} roughness={0.9} />
            </mesh>
            {[-1, 1].map((lado) => (
                <mesh key={lado} position={[lado * (anchoPuerta / 2 + 0.2), alturaAnden + altoPuerta / 2, 0.32]} castShadow>
                    <boxGeometry args={[0.4, altoPuerta, 0.6]} />
                    <meshStandardMaterial color={caucho} roughness={0.9} />
                </mesh>
            ))}

            {/* Borde del andén con franjas y topes de caucho */}
            <mesh position={[0, alturaAnden - 0.08, 0.06]}>
                <boxGeometry args={[anchoPuerta + 0.8, 0.16, 0.12]} />
                <meshStandardMaterial map={franjas} roughness={0.7} />
            </mesh>
            {[-1, 1].map((lado) => (
                <mesh key={lado} position={[lado * 1.05, alturaAnden - 0.42, 0.16]} castShadow>
                    <boxGeometry args={[0.28, 0.5, 0.3]} />
                    <meshStandardMaterial color={caucho} roughness={0.95} />
                </mesh>
            ))}

            {/* Luz de estado sobre el abrigo */}
            <mesh position={[0, yPuerta + 0.7, 0.2]}>
                <boxGeometry args={[anchoPuerta, 0.1, 0.08]} />
                <meshStandardMaterial
                    color={colorEstado}
                    emissive={colorEstado}
                    emissiveIntensity={seleccionado ? 4 : 2.2}
                    toneMapped={false}
                />
            </mesh>

            {/* Lámpara de muelle */}
            <mesh position={[anchoPuerta / 2 + 0.75, yPuerta + 0.1, 0.45]}>
                <boxGeometry args={[0.08, 0.08, 0.9]} />
                <meshStandardMaterial color="#2a2e35" />
            </mesh>
            <mesh position={[anchoPuerta / 2 + 0.75, yPuerta + 0.02, 0.9]}>
                <cylinderGeometry args={[0.16, 0.2, 0.14, 16]} />
                <meshStandardMaterial color="#fff2cc" emissive="#ffe9b0" emissiveIntensity={ocupado ? 2.5 : 0.2} />
            </mesh>

            {/* Bolardos entre bahías */}
            {[-1, 1].map((lado) => (
                <mesh key={lado} position={[lado * (MUELLE.separacion / 2), 0.55, 0.7]} castShadow>
                    <cylinderGeometry args={[0.12, 0.12, 1.1, 16]} />
                    <meshStandardMaterial color="#e8b923" roughness={0.5} />
                </mesh>
            ))}
        </group>
    );
}


/* ---------------------------------------------------------
   CONJUNTO
   --------------------------------------------------------- */

export default function Bodega({ muelles, nombre, colorDe, seleccionado }) {

    const total = muelles.length;

    return (
        <group>
            <Patio total={total} nombresMuelle={muelles.map((m) => `M${m.numero}`)} />
            <Edificio total={total} nombre={nombre} />
            {muelles.map((m, i) => (
                <Muelle
                    key={m.numero}
                    x={xDeMuelle(i, total)}
                    ocupado={!!m.vehiculo}
                    colorEstado={colorDe(m)}
                    seleccionado={m.numero === seleccionado}
                />
            ))}
        </group>
    );
}
