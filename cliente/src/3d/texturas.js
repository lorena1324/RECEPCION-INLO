/* =========================================================
   INLOTRANS
   Texturas procedurales

   Se dibujan en un <canvas> en el navegador: nada que
   descargar, que en las redes de las bodegas importa. Cada
   función guarda su resultado y devuelve un CLON, porque cada
   superficie necesita su propio `repeat` pero la imagen es la
   misma.

   Sin `document` (pruebas en Node) devuelven null y los
   materiales quedan lisos.
   ========================================================= */

import * as THREE from "three";

const cache = new Map();

function lienzo(clave, ancho, alto, dibujar, { color = false } = {}) {

    if (typeof document === "undefined") return null;

    if (!cache.has(clave)) {
        const c = document.createElement("canvas");
        c.width = ancho;
        c.height = alto;
        dibujar(c.getContext("2d"), ancho, alto);

        const t = new THREE.CanvasTexture(c);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 8;
        if (color) t.colorSpace = THREE.SRGBColorSpace;
        cache.set(clave, t);
    }

    return cache.get(clave).clone();
}

export function repetir(textura, x, y) {
    if (textura) textura.repeat.set(x, y);
    return textura;
}

// Ruido de grano fino para romper lo "plástico" de un color plano.
function salpicar(ctx, w, h, cantidad, alfa, tamano = 1) {
    for (let i = 0; i < cantidad; i++) {
        const v = Math.random() * 255 | 0;
        ctx.fillStyle = `rgba(${v},${v},${v},${alfa})`;
        ctx.fillRect(Math.random() * w, Math.random() * h, tamano, tamano);
    }
}

/* Lámina corrugada (contenedores y fachada). Mapa de relieve:
   blanco = alto, negro = bajo. Un periodo por cada 64 px. */
export function relieveCorrugado() {
    return lienzo("corrugado", 256, 16, (ctx, w, h) => {
        const g = ctx.createLinearGradient(0, 0, 64, 0);
        g.addColorStop(0, "#202020");
        g.addColorStop(0.2, "#f0f0f0");
        g.addColorStop(0.5, "#f0f0f0");
        g.addColorStop(0.7, "#202020");
        g.addColorStop(1, "#202020");
        ctx.fillStyle = g;
        for (let x = 0; x < w; x += 64) {
            ctx.save();
            ctx.translate(x, 0);
            ctx.fillRect(0, 0, 64, h);
            ctx.restore();
        }
    });
}

export function texturaAsfalto() {
    return lienzo("asfalto", 512, 512, (ctx, w, h) => {
        ctx.fillStyle = "#4a4f57";
        ctx.fillRect(0, 0, w, h);
        salpicar(ctx, w, h, 26000, 0.13, 2);
        salpicar(ctx, w, h, 9000, 0.25, 1);
        // Manchas de aceite y desgaste.
        for (let i = 0; i < 14; i++) {
            const x = Math.random() * w, y = Math.random() * h, r = 20 + Math.random() * 60;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, "rgba(20,22,26,0.22)");
            g.addColorStop(1, "rgba(20,22,26,0)");
            ctx.fillStyle = g;
            ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
    }, { color: true });
}

// Losas de concreto con juntas, para el andén frente a los muelles.
export function texturaConcreto() {
    return lienzo("concreto", 512, 512, (ctx, w, h) => {
        ctx.fillStyle = "#9da3ab";
        ctx.fillRect(0, 0, w, h);
        salpicar(ctx, w, h, 20000, 0.07, 2);
        ctx.strokeStyle = "rgba(40,44,50,0.45)";
        ctx.lineWidth = 3;
        ctx.strokeRect(0, 0, w, h);
    }, { color: true });
}

// Piso interior pulido de la bodega.
export function texturaPisoInterior() {
    return lienzo("piso", 512, 512, (ctx, w, h) => {
        ctx.fillStyle = "#b9bec5";
        ctx.fillRect(0, 0, w, h);
        salpicar(ctx, w, h, 12000, 0.05, 2);
        ctx.strokeStyle = "rgba(60,64,70,0.25)";
        ctx.lineWidth = 2;
        ctx.strokeRect(0, 0, w, h);
    }, { color: true });
}

// Paneles horizontales de una puerta seccional.
export function relievePuertaSeccional() {
    return lienzo("puerta", 64, 256, (ctx, w, h) => {
        ctx.fillStyle = "#e0e0e0";
        ctx.fillRect(0, 0, w, h);
        for (let y = 0; y < h; y += 64) {
            ctx.fillStyle = "#303030";
            ctx.fillRect(0, y, w, 5);
            ctx.fillStyle = "#b0b0b0";
            ctx.fillRect(0, y + 28, w, 3);
        }
    });
}

// Franjas de seguridad amarillo/negro.
export function texturaFranjas() {
    return lienzo("franjas", 128, 32, (ctx, w, h) => {
        ctx.fillStyle = "#1b1d21";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#f2c230";
        for (let x = -h; x < w + h; x += 32) {
            ctx.beginPath();
            ctx.moveTo(x, h);
            ctx.lineTo(x + 16, h);
            ctx.lineTo(x + 16 + h, 0);
            ctx.lineTo(x + h, 0);
            ctx.fill();
        }
    }, { color: true });
}

// Texto pintado en un letrero o en el piso.
export function texturaTexto(texto, { ancho = 1024, alto = 192, fondo = null, color = "#ffffff", peso = 800, tamano = 110 } = {}) {
    return lienzo(`texto:${texto}:${ancho}:${alto}:${fondo}:${color}:${tamano}`, ancho, alto, (ctx, w, h) => {
        if (fondo) {
            ctx.fillStyle = fondo;
            ctx.fillRect(0, 0, w, h);
        }
        ctx.fillStyle = color;
        // Achica la letra hasta que el texto quepa con margen.
        let t = tamano;
        do {
            ctx.font = `${peso} ${t}px "Segoe UI", system-ui, sans-serif`;
            t -= 4;
        } while (ctx.measureText(texto).width > w * 0.92 && t > 10);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(texto, w / 2, h / 2 + t * 0.04);
    }, { color: true });
}
