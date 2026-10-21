/* =========================================================
   INLOTRANS
   Fusionar lo que no se mueve

   La bodega se arma con cientos de piezas (muros, vigas,
   columnas, zócalos, rayas del piso...). Dibujadas una por una
   son cientos de llamadas a la tarjeta gráfica en CADA cuadro,
   y en un televisor (procesador débil) eso es lo que traba la
   vista, no los píxeles.

   <Fusionar clave={...}> deja que React arme las piezas como
   siempre y, apenas quedan montadas, junta todas las que usan
   el mismo material en UNA sola malla. Se ve igual y se dibuja
   con unas pocas llamadas. Las piezas originales quedan ocultas
   (React las sigue manejando). Cuando cambia `clave` (otro
   número de muelles, otro nombre en el letrero) se vuelve a
   fusionar.

   No se fusiona: lo instanciado (ya es una sola llamada), lo
   transparente (necesita ordenarse al dibujar) ni lo que use
   varios materiales.
   ========================================================= */

import { useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

function firmaMaterial(m) {
    const color = (c) => (c && c.isColor ? c.getHexString() : "");
    const tex = (t) => (t ? t.uuid : "");
    return [
        m.type, color(m.color), m.roughness, m.metalness, color(m.emissive), m.emissiveIntensity,
        tex(m.map), tex(m.bumpMap), m.bumpScale, tex(m.normalMap), tex(m.roughnessMap),
        m.side, m.toneMapped, m.vertexColors, m.flatShading, m.envMapIntensity
    ].join("|");
}

function fusionable(o) {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.visible) return false;
    const m = o.material;
    if (!m || Array.isArray(m)) return false;
    if (m.transparent || m.opacity < 1) return false;
    return !!(o.geometry && o.geometry.attributes.position);
}

// Solo posición, normal y uv, y sin índice: así todas pueden ir juntas.
function prepararGeometria(geo, matriz) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const nombre of Object.keys(g.attributes)) {
        if (!["position", "normal", "uv"].includes(nombre)) g.deleteAttribute(nombre);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
        g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    g.morphAttributes = {};
    g.clearGroups();
    g.applyMatrix4(matriz);
    return g;
}

export default function Fusionar({ clave, children }) {

    const grupo = useRef();

    useLayoutEffect(() => {
        const raiz = grupo.current;
        if (!raiz) return;

        raiz.updateMatrixWorld(true);
        const inversa = new THREE.Matrix4().copy(raiz.matrixWorld).invert();

        const lotes = new Map();
        raiz.traverse((o) => {
            if (!fusionable(o)) return;
            const llave = firmaMaterial(o.material) + "|" + o.castShadow + "|" + o.receiveShadow;
            if (!lotes.has(llave)) lotes.set(llave, { material: o.material, sombra: o.castShadow, recibe: o.receiveShadow, piezas: [] });
            lotes.get(llave).piezas.push(o);
        });

        const fusionadas = [];
        const ocultas = [];

        for (const lote of lotes.values()) {
            if (lote.piezas.length < 2) continue;      // una sola pieza: nada que ganar
            const relativa = new THREE.Matrix4();
            const geos = lote.piezas.map((o) => prepararGeometria(o.geometry, relativa.multiplyMatrices(inversa, o.matrixWorld)));
            const geo = mergeGeometries(geos, false);
            geos.forEach((g) => g.dispose());
            if (!geo) continue;

            const malla = new THREE.Mesh(geo, lote.material);
            malla.castShadow = lote.sombra;
            malla.receiveShadow = lote.recibe;
            malla.matrixAutoUpdate = false;
            raiz.add(malla);
            fusionadas.push(malla);

            lote.piezas.forEach((o) => { o.visible = false; ocultas.push(o); });
        }

        return () => {
            fusionadas.forEach((m) => { raiz.remove(m); m.geometry.dispose(); });
            ocultas.forEach((o) => { o.visible = true; });
        };
    }, [clave]);

    return <group ref={grupo}>{children}</group>;
}
