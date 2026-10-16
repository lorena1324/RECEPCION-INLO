/* =========================================================
   INLOTRANS
   La nave: réplica de la bodega del proyecto MQ

   Sigue el plano de MQ (frontend/src/shared/visual3d/planta/
   escenaPlanta.ts, "LA BODEGA", 2026-10-15) con sus mismas
   coordenadas, convertidas a las de este escenario:

       x(MQ) 40 = muro derecho   →  x = ancho / 2
       z(MQ) 75 = línea de muelles →  z = -1  (un metro adentro,
                                       para no cruzar el muro)

   O sea: la zona administrativa (verde) queda junto a la bahía
   de muelles, afuera, en la esquina izquierda; adentro van el
   módulo de facturación, el corredor de muelles, las columnas de
   estantería (dos hileras, con los cortes del plano), las 4
   líneas automáticas con su banda principal, las líneas manuales,
   embalaje, averías y los escritorios.

   Es solo escenografía: las medidas de muelles y patio
   (medidas.js) no cambian, ni nada de lo que se anima o
   selecciona. El techo no se dibuja (vista en corte).
   ========================================================= */

import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { relieveCorrugado, repetir, texturaPisoInterior, texturaTexto, texturaVidrio } from "../texturas.js";
import { ALTO_MURO, FONDO_BODEGA, MUELLE, anchoBodega, xDeMuelle } from "./medidas.js";

const { alturaAnden } = MUELLE;

// Colores de la marca (los de las vigas y parales de la estantería).
const MARCA = "#2a5ea8";
const NARANJA = "#e07a1f";
const MURO = "#e3e6ec";
const ACERO = "#cdd2dc";
const ACERO_OSCURO = "#8f96a3";
const OSCURO = "#2b2d33";
const CARTON = "#c9a46c";
const CARTON_OSCURO = "#a98350";

// Estantería (plano de MQ): módulos de 2,5 m y 5 niveles. Aquí cada
// nivel mide 2,4 m para que los 5 quepan bajo el muro con el andén.
const EST_MODULO = 2.5;
const EST_NIVELES = 5;
const EST_ALTO_NIVEL = 2.4;
const EST_ALTO = EST_NIVELES * EST_ALTO_NIVEL + 0.3;
const EST_PASO = 5.18;

// Zona administrativa (afuera, junto a la bahía) y facturación (adentro).
const ADMIN = { ancho: 11, fondo: 12.3, alto: 10.8 };
const FACT = { ancho: 4.8, fondo: 6.1 };

// Todo lo de adentro se apoya en el piso interior.
const Y = alturaAnden;


/* ---------------------------------------------------------
   COORDENADAS DE MQ → ESCENARIO
   --------------------------------------------------------- */

// Los dos conversores dependen del ancho de la bodega.
function conversor(total) {
    const dx = anchoBodega(total) / 2 - 40;
    return { X: (x) => x + dx, Z: (z) => z - 76 };
}

// Columnas de estantería: las 8 del plano (k = 0…7, la 7 junto al muro
// derecho) y, si la bodega es más ancha que los 40 m de MQ, las que
// quepan hacia la izquierda con el mismo patrón de las primeras.
function columnasEstanteria(total) {

    const ancho = anchoBodega(total);
    const dx = ancho / 2 - 40;
    const columnas = [];

    for (let k = 7; k >= -12; k--) {
        const centro = 1.98 + EST_PASO * k;
        if (centro + dx - 1.2 < -ancho / 2 + 1.2) break;

        // [z0 en MQ, módulos] de cada tramo de la columna.
        let tramos;
        if (k === 7) tramos = [[2.1, 15], [43.0, 4]];
        else if (k === 6) tramos = [[2.1, 12], [35.2, 2], [49.0, 2]];
        else if (k === 4 || k === 5) tramos = [[2.1, 12], [35.2, 2], [49.0, 7]];
        else tramos = [[2.1, 12], [35.2, 13]];

        columnas.push({ k, centroMQ: centro, centro: centro + dx, tramos });
    }
    return columnas;
}


/* ---------------------------------------------------------
   AYUDAS
   --------------------------------------------------------- */

function Caja({ tamano, posicion, color, sombra = false, ...material }) {
    return (
        <mesh position={posicion} castShadow={sombra} receiveShadow>
            <boxGeometry args={tamano} />
            <meshStandardMaterial color={color} roughness={0.7} {...material} />
        </mesh>
    );
}

function Cilindro({ radio, alto, posicion, color, eje = "y", ...material }) {
    const rotacion = eje === "x" ? [0, 0, Math.PI / 2] : eje === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0];
    return (
        <mesh position={posicion} rotation={rotacion} castShadow>
            <cylinderGeometry args={[radio, radio, alto, 14]} />
            <meshStandardMaterial color={color} roughness={0.6} {...material} />
        </mesh>
    );
}

// Pintura a ras del piso interior. `largo` corre a lo largo de z.
function Pintura({ x, z, ancho, largo, color, y = Y + 0.012 }) {
    return (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, y, z]}>
            <planeGeometry args={[ancho, largo]} />
            <meshStandardMaterial color={color} roughness={0.8} />
        </mesh>
    );
}

// Contorno de una zona (cuatro rayas de 10 cm).
function Contorno({ x0, x1, z0, z1, color = NARANJA }) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
    return (
        <group>
            <Pintura x={cx} z={z0} ancho={w} largo={0.1} color={color} y={Y + 0.014} />
            <Pintura x={cx} z={z1} ancho={w} largo={0.1} color={color} y={Y + 0.014} />
            <Pintura x={x0} z={cz} ancho={0.1} largo={d} color={color} y={Y + 0.014} />
            <Pintura x={x1} z={cz} ancho={0.1} largo={d} color={color} y={Y + 0.014} />
        </group>
    );
}

// Rótulo pintado en el piso, legible desde el patio (el texto corre a
// lo largo de x; con `rotacion` = π/2 corre a lo largo de z).
function RotuloPiso({ texto, x, z, ancho, alto, color = "#3b3f4e", rotacion = 0 }) {
    const mapa = useMemo(() => texturaTexto(texto, { ancho: 1024, alto: Math.round(1024 * alto / ancho), color, tamano: 220 }), [texto, ancho, alto, color]);
    return (
        <mesh rotation={[-Math.PI / 2, 0, rotacion]} position={[x, Y + 0.02, z]}>
            <planeGeometry args={[ancho, alto]} />
            <meshStandardMaterial map={mapa} transparent roughness={0.8} depthWrite={false} />
        </mesh>
    );
}

// Ventanal corrido: vidrio claro con parteluces, visible por las dos caras.
function Ventanal({ largo, posicion, rotacionY = 0, alto = 2.2 }) {
    const mapa = useMemo(() => repetir(texturaVidrio(), largo / 4, 1), [largo]);
    return (
        <mesh position={posicion} rotation={[0, rotacionY, 0]}>
            <planeGeometry args={[largo, alto]} />
            <meshStandardMaterial map={mapa} emissive="#cfdcf2" emissiveIntensity={0.25} roughness={0.2} side={THREE.DoubleSide} />
        </mesh>
    );
}


/* ---------------------------------------------------------
   MUROS Y ESTRUCTURA
   --------------------------------------------------------- */

function Muros({ total, nombre }) {

    const ancho = anchoBodega(total);
    const F = FONDO_BODEGA;
    const A = ALTO_MURO;

    const fachada = useMemo(() => repetir(relieveCorrugado(), ancho / 1.2, 1), [ancho]);
    const lateral = useMemo(() => repetir(relieveCorrugado(), F / 1.2, 1), [F]);
    const letrero = useMemo(() => texturaTexto(nombre, { ancho: 2048, alto: 220, fondo: "#f3f4f6", color: "#1b2533", tamano: 120 }), [nombre]);

    const lamina = { color: MURO, roughness: 0.6, metalness: 0.25, bumpScale: 2.2 };
    const acero = { color: MARCA, metalness: 0.4, roughness: 0.45 };

    // Una columna de la fachada cada dos muelles, en la separación entre
    // bahías: no tapa ninguna puerta ni abrigo.
    const columnasFachada = Array.from({ length: total + 1 }, (_, i) => i)
        .filter((i) => i % 2 === 0)
        .map((i) => xDeMuelle(i, total) - MUELLE.separacion / 2);

    // Columnas de acero cada 10 m, medio embebidas en los muros.
    const columnasLado = [];
    for (let z = 10; z < F - 4; z += 10) columnasLado.push(-z);
    const columnasFondo = [];
    for (let x = -ancho / 2 + 10; x < ancho / 2 - 4; x += 10) columnasFondo.push(x);

    return (
        <group>
            {/* Muro de muelles */}
            <mesh position={[0, A / 2, -0.25]} castShadow receiveShadow>
                <boxGeometry args={[ancho, A, 0.5]} />
                <meshStandardMaterial {...lamina} bumpMap={fachada} />
            </mesh>

            {/* Zócalo de concreto bajo los muelles (el andén) */}
            <Caja tamano={[ancho, alturaAnden, 0.06]} posicion={[0, alturaAnden / 2, 0.02]} color="#8d939b" roughness={0.95} />

            {/* Faja azul de la marca con el letrero, y su raya anaranjada */}
            <Caja tamano={[ancho, 2.6, 0.06]} posicion={[0, A - 1.5, 0.03]} color={MARCA} roughness={0.55} />
            <Caja tamano={[ancho, 0.12, 0.08]} posicion={[0, A - 2.9, 0.04]} color={NARANJA} roughness={0.5} />
            <mesh position={[0, A - 1.5, 0.07]}>
                <planeGeometry args={[Math.min(ancho * 0.55, 24), 1.4]} />
                <meshStandardMaterial map={letrero} roughness={0.6} />
            </mesh>

            {columnasFachada.map((x) => (
                // Llegan hasta la faja azul y no la cruzan: el letrero queda limpio.
                <Caja key={x} tamano={[0.45, A - 2.8 - alturaAnden, 0.4]} posicion={[x, alturaAnden + (A - 2.8 - alturaAnden) / 2, 0.14]} sombra {...acero} />
            ))}

            {/* Reflectores sobre cada columna y bajantes en las esquinas */}
            {columnasFachada.map((x) => (
                <group key={`r${x}`}>
                    <Caja tamano={[0.32, 0.14, 0.4]} posicion={[x, A - 3.1, 0.5]} color="#ffffff" emissive="#fff4dc" emissiveIntensity={1.4} />
                    <Caja tamano={[0.1, 0.1, 0.3]} posicion={[x, A - 3.1, 0.3]} color={ACERO_OSCURO} />
                </group>
            ))}
            {[-1, 1].map((lado) => (
                <group key={`b${lado}`}>
                    <mesh position={[lado * (ancho / 2 - 0.15), A / 2, 0.3]} castShadow>
                        <cylinderGeometry args={[0.06, 0.06, A - 0.4, 10]} />
                        <meshStandardMaterial color={ACERO_OSCURO} metalness={0.5} roughness={0.5} />
                    </mesh>
                    <Caja tamano={[0.2, 0.18, 0.2]} posicion={[lado * (ancho / 2 - 0.15), 0.3, 0.3]} color={ACERO_OSCURO} metalness={0.5} />
                </group>
            ))}

            {/* Viga de coronación */}
            <Caja tamano={[ancho + 1, 0.4, 0.8]} posicion={[0, A + 0.15, -0.2]} sombra {...acero} />
            {[-1, 1].map((lado) => (
                <Caja key={lado} tamano={[0.8, 0.4, F + 0.2]} posicion={[lado * ancho / 2, A + 0.15, -F / 2]} {...acero} />
            ))}

            {/* Muros laterales y de fondo, con zócalo azul y raya anaranjada
                (más gruesos que el muro: se ven por las dos caras) */}
            {[-1, 1].map((lado) => (
                <group key={lado}>
                    <mesh position={[lado * ancho / 2, A / 2, -F / 2]} castShadow receiveShadow>
                        <boxGeometry args={[0.5, A, F]} />
                        <meshStandardMaterial {...lamina} bumpMap={lateral} />
                    </mesh>
                    <Caja tamano={[0.56, 1.6, F]} posicion={[lado * ancho / 2, 0.8, -F / 2]} color={MARCA} roughness={0.6} />
                    <Caja tamano={[0.58, 0.12, F]} posicion={[lado * ancho / 2, 1.66, -F / 2]} color={NARANJA} roughness={0.5} />
                    <Ventanal largo={F - 2} posicion={[lado * (ancho / 2 + 0.28), A - 2.8, -F / 2]} rotacionY={Math.PI / 2} />
                    <Ventanal largo={F - 2} posicion={[lado * (ancho / 2 - 0.28), A - 2.8, -F / 2]} rotacionY={Math.PI / 2} />
                </group>
            ))}
            <mesh position={[0, A / 2, -F]} receiveShadow>
                <boxGeometry args={[ancho, A, 0.5]} />
                <meshStandardMaterial {...lamina} bumpMap={fachada} />
            </mesh>
            <Caja tamano={[ancho, 1.6, 0.56]} posicion={[0, 0.8, -F]} color={MARCA} roughness={0.6} />
            <Caja tamano={[ancho, 0.12, 0.58]} posicion={[0, 1.66, -F]} color={NARANJA} roughness={0.5} />
            <Ventanal largo={ancho - 2} posicion={[0, A - 2.8, -F - 0.28]} />
            <Ventanal largo={ancho - 2} posicion={[0, A - 2.8, -F + 0.28]} />

            {columnasLado.flatMap((z) => [-1, 1].map((lado) => (
                <Caja key={`l${lado}${z}`} tamano={[0.5, A, 0.5]} posicion={[lado * (ancho / 2 - 0.25), A / 2, z]} {...acero} />
            )))}
            {columnasFondo.map((x) => (
                <Caja key={`f${x}`} tamano={[0.5, A, 0.5]} posicion={[x, A / 2, -F + 0.25]} {...acero} />
            ))}

            {/* Cerchas de cubierta (sin cubierta: vista en corte) */}
            {columnasLado.map((z) => (
                <Caja key={`c${z}`} tamano={[ancho - 0.6, 0.35, 0.3]} posicion={[0, A - 0.25, z]} color="#8b939d" metalness={0.6} roughness={0.4} />
            ))}
        </group>
    );
}


/* ---------------------------------------------------------
   PISO Y CORREDOR DE MUELLES
   --------------------------------------------------------- */

function Piso({ total }) {

    const ancho = anchoBodega(total);
    const F = FONDO_BODEGA;
    const { X, Z } = conversor(total);
    const mapa = useMemo(() => repetir(texturaPisoInterior(), ancho / 6, F / 6), [ancho, F]);

    // Corredor blanco de MQ: x 11,3 … 40 y z 72 … 75.
    const x0 = -total * MUELLE.separacion / 2;      // donde empiezan las puertas
    const x1 = X(40) - 0.8;
    const z0 = Z(72);
    const z1 = Z(75);

    return (
        <group>
            <mesh position={[0, alturaAnden / 2, -F / 2 - 0.25]} receiveShadow>
                <boxGeometry args={[ancho - 0.5, alturaAnden, F - 0.5]} />
                <meshStandardMaterial map={mapa} roughness={0.55} />
            </mesh>

            <Pintura x={(x0 + x1) / 2} z={z0} ancho={x1 - x0} largo={0.14} color="#f1f3f5" />
            <Pintura x={(x0 + x1) / 2} z={z1} ancho={x1 - x0} largo={0.14} color="#f1f3f5" />
            <Pintura x={x0} z={(z0 + z1) / 2} ancho={0.14} largo={z1 - z0} color="#f1f3f5" />
            <Pintura x={x1} z={(z0 + z1) / 2} ancho={0.14} largo={z1 - z0} color="#f1f3f5" />
            <RotuloPiso texto="CORREDOR DE MUELLES" x={(x0 + x1) / 2} z={(z0 + z1) / 2} ancho={Math.min((x1 - x0) * 0.4, 22)} alto={1.1} color="#9aa3b1" />
        </group>
    );
}


/* ---------------------------------------------------------
   ESTANTERÍA (instanciada: miles de piezas en pocas llamadas)
   --------------------------------------------------------- */

function Estanterias({ total }) {

    const { Z } = conversor(total);
    const parales = useRef();
    const vigas = useRef();
    const tarimas = useRef();
    const cajas = useRef();

    const piezas = useMemo(() => {

        const p = [], v = [], t = [], c = [];

        for (const { centro, centroMQ, tramos } of columnasEstanteria(total)) {
            for (const [z0, modulos] of tramos) {

                for (let b = 0; b <= modulos; b++) {
                    for (const s of [-1, 1]) p.push([centro + s * 1.2, Y + EST_ALTO / 2, Z(z0 + b * EST_MODULO)]);
                }

                for (let n = 0; n < EST_NIVELES; n++) {
                    const y = Y + 0.15 + n * EST_ALTO_NIVEL;
                    for (let b = 0; b < modulos; b++) {
                        for (const s of [-1, 1]) v.push([centro + s * 1.2, y, Z(z0 + b * EST_MODULO + EST_MODULO / 2)]);

                        for (const lado of [-1, 1]) {
                            for (const q of [0, 1]) {
                                // Algunas posiciones quedan vacías, siempre las mismas
                                // (la misma fórmula del plano de MQ).
                                const h = b * 3 + n * 5 + q * 7 + lado * 11 + Math.round(centroMQ);
                                if (((h % 10) + 10) % 10 >= 7) continue;

                                const px = centro + lado * 0.58;
                                const pz = Z(z0 + b * EST_MODULO + 0.62 + q * 1.25);
                                const alto = 1.45 + (((h % 3) + 3) % 3) * 0.1;

                                t.push([px, y + 0.13, pz]);
                                c.push([px, y + 0.19 + alto / 2, pz, alto, ((h % 4) + 4) % 4]);
                            }
                        }
                    }
                }
            }
        }
        return { p, v, t, c };
    }, [total]);

    useLayoutEffect(() => {

        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const pos = new THREE.Vector3();
        const esc = new THREE.Vector3();
        const color = new THREE.Color();
        // Estibas de cartón, algunas envueltas en film (blanco) y otras más oscuras.
        const TONOS = ["#e9e4da", "#a98350", "#c9a46c", "#c9a46c"];

        piezas.p.forEach(([x, y, z], i) => parales.current.setMatrixAt(i, m.makeTranslation(x, y, z)));
        piezas.v.forEach(([x, y, z], i) => vigas.current.setMatrixAt(i, m.makeTranslation(x, y, z)));
        piezas.t.forEach(([x, y, z], i) => tarimas.current.setMatrixAt(i, m.makeTranslation(x, y, z)));
        piezas.c.forEach(([x, y, z, alto, tipo], i) => {
            m.compose(pos.set(x, y, z), q, esc.set(1, alto, 1));
            cajas.current.setMatrixAt(i, m);
            cajas.current.setColorAt(i, color.set(TONOS[tipo]));
        });

        for (const r of [parales, vigas, tarimas, cajas]) {
            r.current.instanceMatrix.needsUpdate = true;
            if (r.current.instanceColor) r.current.instanceColor.needsUpdate = true;
        }
    }, [piezas]);

    return (
        <group>
            <instancedMesh ref={parales} args={[null, null, piezas.p.length]} castShadow>
                <boxGeometry args={[0.1, EST_ALTO, 0.1]} />
                <meshStandardMaterial color={MARCA} roughness={0.5} metalness={0.4} />
            </instancedMesh>
            <instancedMesh ref={vigas} args={[null, null, piezas.v.length]}>
                <boxGeometry args={[0.07, 0.14, EST_MODULO]} />
                <meshStandardMaterial color={NARANJA} roughness={0.5} metalness={0.3} />
            </instancedMesh>
            <instancedMesh ref={tarimas} args={[null, null, piezas.t.length]}>
                <boxGeometry args={[1.1, 0.12, 1.1]} />
                <meshStandardMaterial color="#9a6f3a" roughness={1} />
            </instancedMesh>
            <instancedMesh ref={cajas} args={[null, null, piezas.c.length]} receiveShadow>
                <boxGeometry args={[1, 1, 1]} />
                <meshStandardMaterial roughness={0.8} />
            </instancedMesh>
        </group>
    );
}


/* ---------------------------------------------------------
   LÍNEAS AUTOMÁTICAS Y BANDA PRINCIPAL
   --------------------------------------------------------- */

// Una línea automática (de MQ): tolva, banda de bolsillos, selladora
// y codificador, con las bolsas ya sobre la banda. Corre a lo largo de x.
function LineaAutomatica({ x0, x1, z, indice }) {

    const largo = x1 - x0;
    const xm = (x0 + x1) / 2;
    const bolsas = useMemo(() => {
        const colores = [MARCA, NARANJA, "#7a4a22", "#e9e4da"];
        return Array.from({ length: 7 }, (_, i) => [x0 + 1.9 + i * 0.52, colores[(i + indice) % colores.length]]);
    }, [x0, indice]);

    return (
        <group>
            {/* Banda de bolsillos sobre su bastidor */}
            <Caja tamano={[largo, 0.05, 0.48]} posicion={[xm, Y + 0.89, z]} color={ACERO_OSCURO} sombra />
            <Caja tamano={[largo, 0.04, 0.4]} posicion={[xm, Y + 0.93, z]} color="#e9ecef" />
            {[-1, 1].map((s) => (
                <group key={s}>
                    <Caja tamano={[largo, 0.14, 0.02]} posicion={[xm, Y + 0.99, z + s * 0.25]} color={ACERO} />
                    <Caja tamano={[largo, 0.3, 0.02]} posicion={[xm, Y + 0.74, z + s * 0.29]} color={ACERO} />
                    {[0.15, largo / 2, largo - 0.15].map((dx) => (
                        <Caja key={dx} tamano={[0.05, 0.9, 0.05]} posicion={[x0 + dx, Y + 0.45, z + s * 0.27]} color={ACERO} />
                    ))}
                </group>
            ))}

            {/* Tolva de alimentación */}
            <Caja tamano={[1.5, 0.5, 0.9]} posicion={[x0 + 0.8, Y + 1.15, z]} color="#1d3f8a" sombra metalness={0.3} />
            <mesh position={[x0 + 0.8, Y + 1.7, z]} rotation={[0, Math.PI / 4, 0]} castShadow>
                <cylinderGeometry args={[0.7, 0.35, 0.6, 4]} />
                <meshStandardMaterial color="#1d3f8a" roughness={0.5} metalness={0.3} />
            </mesh>

            {/* Bolsas sobre la banda */}
            {bolsas.map(([x, c]) => (
                <Caja key={x} tamano={[0.28, 0.05, 0.3]} posicion={[x, Y + 0.98, z]} color={c} />
            ))}

            {/* Selladora y codificador */}
            <Caja tamano={[0.9, 1.3, 0.85]} posicion={[x1 - 1.4, Y + 0.95, z]} color={ACERO} sombra metalness={0.5} roughness={0.4} />
            <Caja tamano={[0.7, 0.4, 0.05]} posicion={[x1 - 1.4, Y + 1.25, z + 0.44]} color="#20232c" roughness={0.3} />
            <Caja tamano={[0.5, 0.06, 0.06]} posicion={[x1 - 1.4, Y + 1.66, z + 0.43]} color="#35c46a" emissive="#35c46a" emissiveIntensity={1.6} />
            <Caja tamano={[0.32, 0.55, 0.45]} posicion={[x1 - 0.45, Y + 1.0, z]} color={OSCURO} sombra />
            <Caja tamano={[0.22, 0.14, 0.04]} posicion={[x1 - 0.45, Y + 1.12, z + 0.24]} color="#7fd0ff" emissive="#7fd0ff" emissiveIntensity={1.2} />
        </group>
    );
}

// Banda de salida compartida, con la estiba de producto terminado al final.
function BandaPrincipal({ x, z0, z1 }) {

    const largo = z1 - z0;
    const zm = (z0 + z1) / 2;

    return (
        <group>
            <Caja tamano={[0.62, 0.1, largo]} posicion={[x, Y + 0.86, zm]} color="#15171b" roughness={0.9} sombra />
            {[-1, 1].map((s) => (
                <Caja key={s} tamano={[0.03, 0.14, largo]} posicion={[x + s * 0.33, Y + 0.95, zm]} color={ACERO} />
            ))}
            {Array.from({ length: Math.floor(largo / 1.8) + 1 }, (_, i) => z0 + i * 1.8).map((z) => (
                <group key={z}>
                    {[-1, 1].map((s) => <Caja key={s} tamano={[0.05, 0.86, 0.05]} posicion={[x + s * 0.3, Y + 0.43, z]} color={ACERO} />)}
                </group>
            ))}
            {/* Estiba esperando al patinador */}
            <Caja tamano={[1.0, 0.12, 1.2]} posicion={[x, Y + 0.06, z1 + 1.1]} color="#9a6f3a" roughness={1} sombra />
            <Caja tamano={[0.95, 1.0, 1.15]} posicion={[x, Y + 0.62, z1 + 1.1]} color={CARTON} roughness={0.8} sombra />
        </group>
    );
}

function ZonaAutomaticas({ total }) {

    const { X, Z } = conversor(total);

    // Cuatro líneas separadas 2,9 m (SEP_AUTO) desde z = 65,8 hacia el fondo.
    const lineas = [0, 1, 2, 3].map((k) => ({ z: Z(65.8 - 2.9 * k), k }));
    const xa = X(29.4);
    const xb = X(35.5);

    return (
        <group>
            <Contorno x0={X(29.25)} x1={X(37.2)} z0={Z(55.2)} z1={Z(67.4)} />
            {lineas.map(({ z, k }) => <LineaAutomatica key={k} x0={xa} x1={xb} z={z} indice={k} />)}
            <BandaPrincipal x={X(36.1)} z0={Z(55.8)} z1={Z(66.2)} />
        </group>
    );
}


/* ---------------------------------------------------------
   LÍNEAS MANUALES
   --------------------------------------------------------- */

// Mesa de armado manual de MQ, girada 90°: su largo corre a lo largo de z.
function LineaManual({ x, z0, z1, indice }) {

    const largo = z1 - z0;
    const zm = (z0 + z1) / 2;
    const tonos = [CARTON, CARTON_OSCURO, "#e9e4da"];

    return (
        <group>
            <Caja tamano={[0.8, 0.06, largo]} posicion={[x, Y + 0.9, zm]} color="#4a7fc1" sombra roughness={0.5} />
            <Caja tamano={[0.8, 0.14, 0.04]} posicion={[x, Y + 0.97, z0]} color="#4a7fc1" />
            {[-1, 1].map((s) => (
                <Caja key={s} tamano={[0.03, 0.12, largo]} posicion={[x + s * 0.4, Y + 0.96, zm]} color={ACERO} />
            ))}
            {Array.from({ length: Math.floor(largo / 1.6) + 1 }, (_, i) => z0 + 0.2 + i * 1.6).map((z) => (
                <group key={z}>
                    {[-1, 1].map((s) => <Caja key={s} tamano={[0.05, 0.88, 0.05]} posicion={[x + s * 0.36, Y + 0.44, z]} color={ACERO} />)}
                </group>
            ))}
            {/* Ofertas armadas sobre la mesa */}
            {[0.15, 0.4, 0.62, 0.84].map((f, i) => (
                <Caja key={f} tamano={[0.36, 0.22, 0.42]} posicion={[x, Y + 1.04, z0 + largo * f]} color={tonos[(i + indice) % tonos.length]} sombra />
            ))}
            {/* Sellado: caja con luz de marcha */}
            <Caja tamano={[0.5, 0.35, 0.5]} posicion={[x, Y + 1.15, z1 - 0.5]} color={ACERO_OSCURO} sombra metalness={0.5} />
            <Caja tamano={[0.3, 0.05, 0.05]} posicion={[x, Y + 1.36, z1 - 0.28]} color="#35c46a" emissive="#35c46a" emissiveIntensity={1.6} />
        </group>
    );
}

function ZonaManual({ total }) {

    const { X, Z } = conversor(total);

    return (
        <group>
            {/* Tres líneas manuales en el hueco que dejan las columnas 4 y 5
                (x 21,5 … 26, z 40,8 … 49) */}
            <Contorno x0={X(20.5)} x1={X(27.0)} z0={Z(40.3)} z1={Z(49.4)} />
            {[0, 1, 2].map((j) => (
                <LineaManual key={j} x={X(21.5 + 2.3 * j + 0.4)} z0={Z(40.9)} z1={Z(49.0)} indice={j} />
            ))}
        </group>
    );
}


/* ---------------------------------------------------------
   EMBALAJE, AVERÍAS Y ESCRITORIOS
   --------------------------------------------------------- */

function Mesa({ x, z, largo, ancho = 1.0 }) {
    return (
        <group>
            <Caja tamano={[ancho, 0.05, largo]} posicion={[x, Y + 0.9, z]} color={ACERO} metalness={0.7} roughness={0.4} sombra />
            {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => (
                <Caja key={`${sx}${sz}`} tamano={[0.05, 0.88, 0.05]} posicion={[x + sx * (ancho / 2 - 0.05), Y + 0.44, z + sz * (largo / 2 - 0.05)]} color={ACERO} metalness={0.7} />
            )))}
        </group>
    );
}

function Embalaje({ total }) {

    const { X, Z } = conversor(total);

    return (
        <group>
            <Pintura x={X(35.6)} z={Z(47.95)} ancho={2.8} largo={8.5} color="#c9c09b" />
            <RotuloPiso texto="EMBALAJE" x={X(34.75)} z={Z(47.95)} ancho={4.6} alto={0.8} rotacion={Math.PI / 2} />
            {[46.2, 49.7].map((z) => (
                <group key={z}>
                    <Mesa x={X(36.15)} z={Z(z)} largo={1.6} />
                    <Caja tamano={[0.4, 0.3, 0.5]} posicion={[X(36.15), Y + 1.07, Z(z)]} color={CARTON} sombra />
                </group>
            ))}
            {[[34.9, 44.4], [36.3, 51.4]].map(([x, z]) => (
                <group key={z}>
                    <Caja tamano={[1.0, 0.12, 1.2]} posicion={[X(x), Y + 0.06, Z(z)]} color={CARTON_OSCURO} sombra />
                    <Caja tamano={[1.0, 1.0, 1.2]} posicion={[X(x), Y + 0.62, Z(z)]} color={CARTON} sombra />
                </group>
            ))}
        </group>
    );
}

function Averias({ total }) {

    const { X, Z } = conversor(total);
    const cx = X(38.25);
    const cz = Z(41.25);

    return (
        <group>
            <Pintura x={cx} z={cz} ancho={2.1} largo={2.7} color="#d99a9a" />
            <RotuloPiso texto="AVERÍAS" x={cx} z={cz} ancho={2.3} alto={0.5} color="#7a2f2f" rotacion={Math.PI / 2} />
            {/* Jaula con cajas dañadas */}
            {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => (
                <Caja key={`${sx}${sz}`} tamano={[0.05, 1.5, 0.05]} posicion={[cx + sx * 0.9, Y + 0.75, cz + sz * 1.15]} color={ACERO} metalness={0.7} />
            )))}
            {[[-0.4, -0.5, 0.55], [0.35, 0.3, 0.4], [-0.1, 0.8, 0.35], [0.4, -0.7, 0.3]].map(([dx, dz, h], i) => (
                <Caja key={i} tamano={[0.6, h * 1.6, 0.6]} posicion={[cx + dx, Y + h * 0.8, cz + dz]} color={i % 2 ? CARTON_OSCURO : CARTON} sombra />
            ))}
        </group>
    );
}

// Dos hileras de puestos con pantalla y silla, a la derecha de la banda principal.
function Escritorios({ total }) {

    const { X, Z } = conversor(total);
    const madera = { color: "#8a5a2b", roughness: 0.6 };

    const hilera = (z0, largo, puestos) => {
        const zc = z0 + largo / 2;
        return (
            <group key={z0}>
                <Caja tamano={[0.8, 0.05, largo]} posicion={[X(38.55), Y + 0.76, Z(zc)]} sombra {...madera} />
                {[z0 + 0.1, z0 + largo - 0.1].map((z) => (
                    <Caja key={z} tamano={[0.7, 0.72, 0.05]} posicion={[X(38.55), Y + 0.38, Z(z)]} {...madera} />
                ))}
                {Array.from({ length: puestos }, (_, p) => z0 + (largo / puestos) * (p + 0.5)).map((z) => (
                    <group key={z}>
                        <Caja tamano={[0.04, 0.34, 0.5]} posicion={[X(38.78), Y + 0.96, Z(z)]} color="#20232c" roughness={0.3} />
                        <Caja tamano={[0.05, 0.06, 0.2]} posicion={[X(38.78), Y + 0.8, Z(z)]} color={OSCURO} />
                        <Cilindro radio={0.2} alto={0.06} posicion={[X(37.9), Y + 0.5, Z(z)]} color={OSCURO} />
                        <Cilindro radio={0.025} alto={0.46} posicion={[X(37.9), Y + 0.25, Z(z)]} color={OSCURO} />
                        <Caja tamano={[0.06, 0.42, 0.4]} posicion={[X(37.7), Y + 0.78, Z(z)]} color={OSCURO} />
                    </group>
                ))}
            </group>
        );
    };

    return <group>{hilera(55.5, 3.0, 3)}{hilera(60.0, 4.0, 4)}</group>;
}


/* ---------------------------------------------------------
   EDIFICIOS
   --------------------------------------------------------- */

const GRIS_CLARO = "#cfd3dc";
const CONCRETO = "#b9bec6";

// Unidad condensadora de aire acondicionado (techos).
function Aire({ posicion }) {
    return (
        <group position={posicion}>
            <Caja tamano={[1.1, 0.7, 0.9]} posicion={[0, 0.35, 0]} color="#d8dce2" sombra metalness={0.3} />
            <Caja tamano={[1.0, 0.04, 0.8]} posicion={[0, 0.72, 0]} color="#9aa1ac" />
            <Cilindro radio={0.3} alto={0.03} posicion={[0, 0.75, 0]} color="#2b2d33" />
            {[-0.3, 0, 0.3].map((dx) => (
                <Caja key={dx} tamano={[0.03, 0.5, 0.82]} posicion={[0.56, 0.36, dx * 0.5]} color="#9aa1ac" />
            ))}
        </group>
    );
}

// Franja de ventanas con marco, alféizar y visera. Se arma en su propio
// marco local: +z es hacia afuera de la fachada que decora.
function FranjaVentanas({ ancho, y, mapa, x = 0, alto = 1.1 }) {
    return (
        <group position={[x, y, 0]}>
            <mesh position={[0, 0, 0.11]}>
                <planeGeometry args={[ancho, alto]} />
                <meshStandardMaterial map={mapa} emissive="#cfdcf2" emissiveIntensity={0.25} roughness={0.2} />
            </mesh>
            <Caja tamano={[ancho + 0.12, 0.07, 0.05]} posicion={[0, alto / 2 + 0.03, 0.12]} color="#e9ecef" />
            <Caja tamano={[ancho + 0.12, 0.07, 0.05]} posicion={[0, -alto / 2 - 0.03, 0.12]} color="#e9ecef" />
            {[-1, 1].map((s) => (
                <Caja key={s} tamano={[0.07, alto + 0.14, 0.05]} posicion={[s * (ancho / 2 + 0.03), 0, 0.12]} color="#e9ecef" />
            ))}
            {/* Alféizar y visera de sombra */}
            <Caja tamano={[ancho + 0.3, 0.08, 0.3]} posicion={[0, -alto / 2 - 0.1, 0.24]} color={GRIS_CLARO} />
            <Caja tamano={[ancho + 0.3, 0.06, 0.55]} posicion={[0, alto / 2 + 0.14, 0.38]} color={MARCA} roughness={0.5} />
        </group>
    );
}

// Zona administrativa (verde en el plano): tres pisos junto a la bahía
// de muelles, afuera, en la esquina izquierda. Mira al patio (+z) y a
// los muelles (+x).
function ZonaAdministrativa({ total }) {

    const ancho = anchoBodega(total);
    const { ancho: w, fondo: d, alto: h } = ADMIN;
    const x = -ancho / 2 + 7.9 - w / 2;
    const z = d / 2;

    const vidrioFrente = useMemo(() => repetir(texturaVidrio(), (w - 1.2) / 3, 1), [w]);
    const vidrioPiso1 = useMemo(() => repetir(texturaVidrio(), 6.4 / 3, 1), []);
    const vidrioLado = useMemo(() => repetir(texturaVidrio(), (d - 1.2) / 3, 1), [d]);
    const rotulo = useMemo(() => texturaTexto("ADMINISTRACIÓN", { ancho: 1536, alto: 144, fondo: MARCA, color: "#ffffff", tamano: 110 }), []);
    const bandera = useMemo(() => texturaTexto("INLOTRANS", { ancho: 512, alto: 320, fondo: NARANJA, color: "#ffffff", tamano: 90 }), []);

    const puertaX = w / 2 - 2.4;            // la entrada, hacia la bahía
    const azotea = h + 0.3;

    return (
        <group position={[x, 0, z]}>

            {/* Cuerpo, zócalo verde, cintas de entrepiso, losa y remate */}
            <Caja tamano={[w, h, d]} posicion={[0, h / 2, 0]} color="#e9ebf1" sombra />
            <Caja tamano={[w + 0.2, 1.1, d + 0.2]} posicion={[0, 0.55, 0]} color="#7cc243" roughness={0.6} />
            {[3.6, 7.2].map((y) => (
                <Caja key={y} tamano={[w + 0.2, 0.18, d + 0.2]} posicion={[0, y, 0]} color={MARCA} roughness={0.55} />
            ))}
            <Caja tamano={[w + 0.5, 0.3, d + 0.5]} posicion={[0, h + 0.15, 0]} color="#c4c7d2" roughness={0.8} />
            <Caja tamano={[w + 0.3, 0.12, d + 0.3]} posicion={[0, h - 0.06, 0]} color={NARANJA} roughness={0.5} />

            {/* Pilastras de esquina y bajantes */}
            {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => (
                <group key={`${sx}${sz}`}>
                    <Caja tamano={[0.42, h, 0.42]} posicion={[sx * (w / 2), h / 2, sz * (d / 2)]} color={GRIS_CLARO} sombra />
                    <Cilindro radio={0.05} alto={h - 0.4} posicion={[sx * (w / 2 + 0.26), (h - 0.4) / 2, sz * (d / 2 + 0.05)]} color="#8f96a3" metalness={0.5} />
                </group>
            )))}

            {/* Fachada que mira al patio (+z): pisos 2 y 3 corridos y el primero partido por la puerta */}
            <group position={[0, 0, d / 2]}>
                <FranjaVentanas ancho={w - 1.4} y={5.8} mapa={vidrioFrente} />
                <FranjaVentanas ancho={w - 1.4} y={8.9} mapa={vidrioFrente} />
                <FranjaVentanas ancho={6.4} y={2.4} x={-w / 2 + 0.7 + 3.2} mapa={vidrioPiso1} />
            </group>

            {/* Fachada que mira a los muelles (+x) */}
            <group position={[w / 2, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
                {[2.4, 5.8, 8.9].map((y) => <FranjaVentanas key={y} ancho={d - 1.6} y={y} mapa={vidrioLado} />)}
            </group>

            {/* Rótulo pegado a la fachada del patio, de frente */}
            <mesh position={[0, 10.15, d / 2 + 0.06]}>
                <planeGeometry args={[w - 1.4, 0.95]} />
                <meshStandardMaterial map={rotulo} roughness={0.5} />
            </mesh>

            {/* Entrada: puerta de vidrio doble, marquesina, escalones y pasamanos */}
            <group position={[puertaX, 0, d / 2]}>
                <Caja tamano={[2.1, 2.55, 0.1]} posicion={[0, 1.3, 0.05]} color="#3a3f47" metalness={0.4} />
                {[-1, 1].map((s) => (
                    <mesh key={s} position={[s * 0.47, 1.25, 0.12]}>
                        <planeGeometry args={[0.88, 2.3]} />
                        <meshStandardMaterial color="#9fc0dc" emissive="#7ea6c8" emissiveIntensity={0.3} roughness={0.1} metalness={0.4} />
                    </mesh>
                ))}
                {[-1, 1].map((s) => <Caja key={s} tamano={[0.04, 0.5, 0.05]} posicion={[s * 0.1, 1.15, 0.16]} color={ACERO} metalness={0.9} />)}
                <Caja tamano={[3.6, 0.14, 1.7]} posicion={[0, 3.0, 0.85]} color={MARCA} roughness={0.5} sombra />
                <Caja tamano={[3.6, 0.3, 0.06]} posicion={[0, 3.18, 1.7]} color={NARANJA} roughness={0.5} />
                {[-1, 1].map((s) => <Cilindro key={s} radio={0.06} alto={2.95} posicion={[s * 1.6, 1.47, 1.55]} color={ACERO} metalness={0.8} />)}
                <Caja tamano={[2.6, 0.14, 0.55]} posicion={[0, 0.07, 0.62]} color={CONCRETO} />
                <Caja tamano={[2.6, 0.14, 0.55]} posicion={[0, 0.21, 0.35]} color={CONCRETO} />
                {[-1, 1].map((s) => <Cilindro key={s} radio={0.025} alto={1.3} eje="z" posicion={[s * 1.4, 0.85, 0.75]} color={ACERO} metalness={0.8} />)}
                {[-1, 1].map((s) => (
                    <Caja key={s} tamano={[0.25, 0.1, 0.12]} posicion={[s * 1.3, 2.7, 0.14]} color="#ffffff" emissive="#fff4dc" emissiveIntensity={1.4} />
                ))}
            </group>

            {/* Puerta de emergencia por el costado de los muelles */}
            <group position={[w / 2, 0, -d / 2 + 2.2]} rotation={[0, Math.PI / 2, 0]}>
                <Caja tamano={[1.2, 2.2, 0.08]} posicion={[0, 1.2, 0.05]} color="#b3322c" metalness={0.3} />
                <Caja tamano={[1.5, 0.12, 0.6]} posicion={[0, 2.45, 0.3]} color={GRIS_CLARO} />
                <Caja tamano={[0.4, 0.1, 0.03]} posicion={[0, 2.62, 0.08]} color="#35c46a" emissive="#35c46a" emissiveIntensity={1.4} />
            </group>

            {/* Azotea: antepecho, equipos de aire, tanque, caseta de escalera y antena */}
            {[[0, d / 2 + 0.125, w + 0.5, 0.15], [0, -d / 2 - 0.125, w + 0.5, 0.15]].map(([px, pz, lw, ld], i) => (
                <Caja key={i} tamano={[lw, 0.6, ld]} posicion={[px, azotea + 0.3, pz]} color="#c4c7d2" roughness={0.8} />
            ))}
            {[-1, 1].map((s) => (
                <Caja key={s} tamano={[0.15, 0.6, d + 0.5]} posicion={[s * (w / 2 + 0.125), azotea + 0.3, 0]} color="#c4c7d2" roughness={0.8} />
            ))}
            {[[-3.6, -2.4], [-3.6, 0.2], [-1.6, -2.4]].map(([ax, az]) => <Aire key={`${ax}${az}`} posicion={[ax, azotea, az]} />)}
            <group position={[3.2, azotea, -2.6]}>
                <Cilindro radio={0.8} alto={1.5} posicion={[0, 1.65, 0]} color="#d9dde3" metalness={0.3} />
                <Cilindro radio={0.8} alto={0.06} posicion={[0, 2.43, 0]} color={ACERO_OSCURO} />
                {[[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].map(([px, pz]) => (
                    <Caja key={`${px}${pz}`} tamano={[0.08, 0.9, 0.08]} posicion={[px, 0.45, pz]} color={ACERO_OSCURO} />
                ))}
            </group>
            <group position={[-0.6, azotea, 2.6]}>
                <Caja tamano={[2.2, 2.4, 2.0]} posicion={[0, 1.2, 0]} color="#e9ebf1" sombra />
                <Caja tamano={[2.4, 0.15, 2.2]} posicion={[0, 2.47, 0]} color="#c4c7d2" />
                <Caja tamano={[0.9, 1.9, 0.05]} posicion={[0, 0.95, 1.03]} color="#3a3f47" />
            </group>
            <Cilindro radio={0.03} alto={4} posicion={[-w / 2 + 0.8, azotea + 2, d / 2 - 0.8]} color={ACERO} metalness={0.8} />
            {[1.4, 2.4, 3.3].map((y) => <Caja key={y} tamano={[0.9 - y * 0.12, 0.03, 0.03]} posicion={[-w / 2 + 0.8, azotea + y, d / 2 - 0.8]} color={ACERO} />)}

            {/* Asta con la bandera, frente a la fachada */}
            <group position={[-w / 2 - 1.4, 0, d / 2 + 1.8]}>
                <Caja tamano={[0.5, 0.3, 0.5]} posicion={[0, 0.15, 0]} color={CONCRETO} />
                <Cilindro radio={0.05} alto={7.5} posicion={[0, 3.9, 0]} color={ACERO} metalness={0.8} />
                <mesh position={[0.65, 7.0, 0]}>
                    <planeGeometry args={[1.3, 0.8]} />
                    <meshStandardMaterial map={bandera} side={THREE.DoubleSide} roughness={0.8} />
                </mesh>
            </group>
        </group>
    );
}

// Facturación (celeste): un piso, adentro, pegado al corredor, junto al
// muro izquierdo (MQ: x 0 … 4,8, z 68,6 … 74,7). Puerta y rótulo hacia el
// corredor (+z).
function Facturacion({ total }) {

    const ancho = anchoBodega(total);
    const { ancho: w, fondo: d } = FACT;
    const x = -ancho / 2 + 0.25 + w / 2;
    const z = (conversor(total).Z(68.6) + conversor(total).Z(74.7)) / 2;

    const vidrioLado = useMemo(() => repetir(texturaVidrio(), (d - 1.2) / 2, 1), [d]);
    const vidrioFrente = useMemo(() => repetir(texturaVidrio(), 2.2 / 2, 1), []);
    const rotulo = useMemo(() => texturaTexto("FACTURACIÓN", { ancho: 1024, alto: 150, fondo: "#2f6f86", color: "#ffffff", tamano: 110 }), []);

    return (
        <group position={[x, Y, z]}>

            {/* Cuerpo, zócalo, losa y antepecho */}
            <Caja tamano={[w, 3, d]} posicion={[0, 1.5, 0]} color="#93cfe0" sombra />
            <Caja tamano={[w + 0.1, 0.5, d + 0.1]} posicion={[0, 0.25, 0]} color="#5f9fb4" />
            <Caja tamano={[w + 0.3, 0.2, d + 0.3]} posicion={[0, 3.1, 0]} color="#c4c7d2" roughness={0.8} />
            {[[0, d / 2 + 0.14, w + 0.3, 0.1], [0, -d / 2 - 0.14, w + 0.3, 0.1]].map(([px, pz, lw, ld], i) => (
                <Caja key={i} tamano={[lw, 0.35, ld]} posicion={[px, 3.38, pz]} color="#c4c7d2" roughness={0.8} />
            ))}
            {[-1, 1].map((s) => <Caja key={s} tamano={[0.1, 0.35, d + 0.3]} posicion={[s * (w / 2 + 0.14), 3.38, 0]} color="#c4c7d2" roughness={0.8} />)}

            {/* Lado de los muelles (+x): ventanal con alféizar y visera */}
            <group position={[w / 2, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
                <FranjaVentanas ancho={d - 1.4} y={1.75} mapa={vidrioLado} alto={1.0} />
            </group>

            {/* Lado del corredor (+z): ventana, puerta, marquesina y rótulo */}
            <group position={[0, 0, d / 2]}>
                <FranjaVentanas ancho={2.2} y={1.75} x={-w / 2 + 1.5} mapa={vidrioFrente} alto={1.0} />
                <Caja tamano={[1.1, 2.15, 0.08]} posicion={[w / 2 - 1.1, 1.08, 0.04]} color="#3a3f47" metalness={0.4} />
                <mesh position={[w / 2 - 1.1, 1.15, 0.09]}>
                    <planeGeometry args={[0.9, 1.95]} />
                    <meshStandardMaterial color="#9fc0dc" emissive="#7ea6c8" emissiveIntensity={0.3} roughness={0.1} metalness={0.4} />
                </mesh>
                <Caja tamano={[1.7, 0.08, 0.8]} posicion={[w / 2 - 1.1, 2.4, 0.4]} color={MARCA} roughness={0.5} />
                <Caja tamano={[1.4, 0.1, 0.6]} posicion={[w / 2 - 1.1, 0.05, 0.4]} color={CONCRETO} />
                <mesh position={[0, 2.78, 0.06]}>
                    <planeGeometry args={[w - 0.6, 0.45]} />
                    <meshStandardMaterial map={rotulo} roughness={0.5} />
                </mesh>
                {[-1, 1].map((s) => (
                    <group key={s} position={[w / 2 - 1.1 + s * 1.0, 0, 0.9]}>
                        <Cilindro radio={0.08} alto={0.9} posicion={[0, 0.45, 0]} color={NARANJA} />
                        <Cilindro radio={0.085} alto={0.06} posicion={[0, 0.92, 0]} color={OSCURO} />
                    </group>
                ))}
            </group>

            {/* Techo: aire acondicionado y ventilación */}
            <Aire posicion={[-1.0, 3.2, -1.2]} />
            <Cilindro radio={0.22} alto={0.5} posicion={[1.2, 3.55, 1.0]} color="#9aa1ac" metalness={0.5} />
            <Cilindro radio={0.3} alto={0.06} posicion={[1.2, 3.83, 1.0]} color="#6f7684" metalness={0.5} />
        </group>
    );
}


/* ---------------------------------------------------------
   ENTORNO: portería y alumbrado del patio
   --------------------------------------------------------- */

// Caseta de vigilancia con la pluma levantada junto al carril de entrada,
// y postes de luz a lo largo del patio. No tocan el carril ni los cupos.
function Entorno({ total }) {

    const ancho = anchoBodega(total);
    const xb = ancho / 2 + 10;
    const postes = [];
    for (let px = -ancho / 2 + 6; px < ancho / 2 + 22; px += 16) postes.push(px);

    const letrero = useMemo(() => texturaTexto("PORTERÍA", { ancho: 512, alto: 128, fondo: MARCA, color: "#ffffff", tamano: 90 }), []);

    return (
        <group>
            {/* Caseta */}
            <group position={[xb, 0, 28.5]}>
                <Caja tamano={[0.6, 0.18, 0.6]} posicion={[0, 0.09, 0]} color={CONCRETO} />
                <Caja tamano={[2.6, 2.5, 2.6]} posicion={[0, 1.4, 0]} color="#eef0f3" sombra />
                <Caja tamano={[3.1, 0.2, 3.1]} posicion={[0, 2.75, 0]} color={MARCA} roughness={0.5} sombra />
                <Caja tamano={[3.1, 0.08, 3.1]} posicion={[0, 2.88, 0]} color={NARANJA} roughness={0.5} />
                <mesh position={[0, 1.7, 1.31]}>
                    <planeGeometry args={[2.0, 0.9]} />
                    <meshStandardMaterial color="#9fc0dc" emissive="#7ea6c8" emissiveIntensity={0.35} roughness={0.1} metalness={0.4} />
                </mesh>
                <mesh position={[1.31, 1.7, 0]} rotation={[0, Math.PI / 2, 0]}>
                    <planeGeometry args={[2.0, 0.9]} />
                    <meshStandardMaterial color="#9fc0dc" emissive="#7ea6c8" emissiveIntensity={0.35} roughness={0.1} metalness={0.4} />
                </mesh>
                <mesh position={[0, 2.25, 1.32]}>
                    <planeGeometry args={[1.6, 0.4]} />
                    <meshStandardMaterial map={letrero} roughness={0.5} />
                </mesh>
            </group>

            {/* Pluma, levantada, junto al carril */}
            <group position={[xb - 2.4, 0, 25.5]}>
                <Caja tamano={[0.4, 1.1, 0.4]} posicion={[0, 0.55, 0]} color="#e8b923" sombra />
                <group position={[0, 1.0, 0]} rotation={[1.3, 0, 0]}>
                    {[0, 1, 2, 3].map((i) => (
                        <Caja key={i} tamano={[0.1, 0.1, 0.9]} posicion={[0, 0, -0.45 - i * 0.9]} color={i % 2 ? "#f1f3f5" : "#c4161c"} />
                    ))}
                </group>
            </group>

            {/* Postes de luz */}
            {postes.map((px) => (
                <group key={px} position={[px, 0, 31]}>
                    <Caja tamano={[0.5, 0.25, 0.5]} posicion={[0, 0.125, 0]} color={CONCRETO} />
                    <Cilindro radio={0.1} alto={9} posicion={[0, 4.5, 0]} color="#59606a" metalness={0.6} sombra />
                    <Caja tamano={[0.12, 0.12, 2.2]} posicion={[0, 9.0, -1.1]} color="#59606a" metalness={0.6} />
                    <Caja tamano={[0.7, 0.1, 0.4]} posicion={[0, 8.92, -2.2]} color="#ffffff" emissive="#fff4dc" emissiveIntensity={1.6} />
                </group>
            ))}
        </group>
    );
}


/* ---------------------------------------------------------
   LÁMPARAS sobre los pasillos
   --------------------------------------------------------- */

function Lamparas({ total }) {

    const columnas = columnasEstanteria(total).map((c) => c.centro).sort((a, b) => a - b);
    const pasillos = columnas.slice(1).map((x, i) => (x + columnas[i]) / 2);
    const zs = [];
    for (let z = 8; z < FONDO_BODEGA - 3; z += 9) zs.push(-z);

    return (
        <group>
            {pasillos.flatMap((x) => zs.map((z) => (
                <mesh key={`${x}${z}`} position={[x, ALTO_MURO - 0.9, z]}>
                    <boxGeometry args={[0.22, 0.07, 3]} />
                    <meshStandardMaterial color="#ffffff" emissive="#fff4dc" emissiveIntensity={1.1} roughness={0.4} />
                </mesh>
            )))}
        </group>
    );
}


/* ---------------------------------------------------------
   CONJUNTO
   --------------------------------------------------------- */

export default function Edificio({ total, nombre }) {
    return (
        <group>
            <Muros total={total} nombre={nombre} />
            <Piso total={total} />
            <Estanterias total={total} />
            <ZonaAutomaticas total={total} />
            <ZonaManual total={total} />
            <Embalaje total={total} />
            <Averias total={total} />
            <Escritorios total={total} />
            <Facturacion total={total} />
            <ZonaAdministrativa total={total} />
            <Entorno total={total} />
            <Lamparas total={total} />
        </group>
    );
}
