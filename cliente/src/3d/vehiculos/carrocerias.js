/* =========================================================
   INLOTRANS
   Carrocerías

   Las rígidas solo cambian medidas. La tractomula es la única
   con forma propia: es articulada (tractocamión +
   semirremolque con contenedor) y por eso sobrescribe el
   chasis y la cabina.
   ========================================================= */

import * as THREE from "three";

import { ModeloVehiculo } from "./ModeloVehiculo.js";

export class Turbo extends ModeloVehiculo {
    static especificacion = {
        nombre: "Turbo",
        carga: { largo: 4.4, ancho: 2.2, alto: 2.2 },
        alturaPiso: 1.0,
        cabina: { largo: 1.7, alto: 2.1, ancho: 2.1 },
        separacion: 0.15,
        ejes: [1.0, 5.4],
        radioRueda: 0.42
    };
}

export class Sencillo extends ModeloVehiculo {
    static especificacion = {
        nombre: "Sencillo",
        carga: { largo: 6.6, ancho: 2.45, alto: 2.5 },
        alturaPiso: 1.15,
        cabina: { largo: 1.9, alto: 2.4, ancho: 2.35 },
        separacion: 0.15,
        ejes: [1.4, 7.7],
        radioRueda: 0.5
    };
}

export class DobleTroque extends ModeloVehiculo {
    static especificacion = {
        nombre: "Doble troque",
        carga: { largo: 8.2, ancho: 2.5, alto: 2.6 },
        alturaPiso: 1.2,
        cabina: { largo: 2.0, alto: 2.5, ancho: 2.4 },
        separacion: 0.15,
        ejes: [1.2, 2.6, 9.4],
        radioRueda: 0.5
    };
}

export class Tractomula extends ModeloVehiculo {

    static especificacion = {
        nombre: "Tractomula",
        carga: { largo: 12.2, ancho: 2.55, alto: 2.7 },
        alturaPiso: 1.3,
        cabina: { largo: 2.3, alto: 2.9, ancho: 2.45 },
        separacion: 0.9,
        // Tres ejes del semirremolque atrás, dos del tractocamión
        // bajo la quinta rueda y el eje direccional adelante.
        ejes: [0.9, 2.2, 3.5, 10.9, 12.2, 14.3],
        radioRueda: 0.5
    };

    // Contenedores de colores, como en cualquier patio de carga.
    static coloresCarga = ["#d9822b", "#b33a2e", "#2f65a8", "#c7cbd1", "#c9a23a", "#3e7a57"];

    // Dos chasis separados unidos por la quinta rueda.
    construirChasis() {

        const { carga: c, alturaPiso: p, radioRueda: r } = this.esp;
        const acero = this.crearMaterial("#24272d", { roughness: 0.7, metalness: 0.4 });

        // Semirremolque, con sus patas de apoyo.
        for (const x of [-0.5, 0.5]) this.caja([0.16, 0.24, c.largo - 0.5], [x, p - 0.2, c.largo / 2], acero);
        for (const x of [-0.6, 0.6]) this.caja([0.12, p - 0.3, 0.12], [x, (p - 0.3) / 2 + 0.05, c.largo - 3.4], acero);
        this.caja([c.ancho * 0.9, 0.14, 0.14], [0, 0.6, 0.12], acero);

        // Tractocamión.
        const desde = c.largo - 2.4;
        const largo = this.largoTotal - desde - 0.15;
        for (const x of [-0.45, 0.45]) this.caja([0.16, 0.28, largo], [x, r + 0.22, desde + largo / 2], acero);

        // Quinta rueda.
        const quinta = new THREE.Mesh(
            new THREE.CylinderGeometry(0.62, 0.62, 0.1, 28),
            this.crearMaterial("#11161d", { roughness: 0.5, metalness: 0.6 })
        );
        quinta.position.set(0, p - 0.38, c.largo - 1.1);
        this.add(quinta);

        this.construirTanque(c.largo + this.esp.separacion - 0.2);
    }

    // Cabina con deflector de techo y exostos cromados.
    construirCabina() {

        super.construirCabina();

        const { carga, separacion, cabina } = this.esp;
        const zc = carga.largo + separacion;
        const techo = this.pisoCabina + cabina.alto;
        const pintura = new THREE.MeshPhysicalMaterial({ color: this.colorCabina, roughness: 0.3, clearcoat: 0.8 });

        const deflector = this.redondeada(
            [cabina.ancho * 0.94, 0.55, cabina.largo * 0.75],
            [0, techo + 0.24, zc + cabina.largo * 0.42],
            pintura, 0.2
        );
        deflector.rotation.x = -0.14;

        const cromo = this.crearMaterial("#d3d8df", { roughness: 0.15, metalness: 1 });
        for (const lado of [-1, 1]) {
            const exosto = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 16), cromo);
            exosto.position.set(lado * (cabina.ancho / 2 - 0.15), this.pisoCabina + 1.5, zc - 0.12);
            exosto.castShadow = true;
            this.add(exosto);
        }
    }
}
