/* =========================================================
   INLOTRANS
   Carrocerías

   Rígidas (NHR, Turbo, Sencillo, Doble troque): solo cambian
   medidas. Articuladas (Mini mula, Tractomula, Tractomula
   furgón): tractocamión + semirremolque, con chasis y cabina
   propios. "Sin cabezote": el semirremolque o el contenedor
   solos, apoyados en sus patas, sin cabina ni tractocamión
   (`sinCabezote: true` en la especificación).
   ========================================================= */

import * as THREE from "three";

import { relieveCorrugado, repetir } from "../texturas.js";
import { ModeloVehiculo } from "./ModeloVehiculo.js";

/* ---------------------------------------------------------
   RÍGIDAS
   --------------------------------------------------------- */

export class Nhr extends ModeloVehiculo {
    static especificacion = {
        nombre: "Camión liviano (NHR)",
        carga: { largo: 3.6, ancho: 2.0, alto: 2.0 },
        alturaPiso: 0.95,
        cabina: { largo: 1.4, alto: 1.9, ancho: 1.9 },
        separacion: 0.1,
        ejes: [0.85, 4.4],
        radioRueda: 0.36
    };
}

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


/* ---------------------------------------------------------
   ARTICULADAS
   --------------------------------------------------------- */

/*
    Base de todo lo que lleva semirremolque. Dos chasis separados
    unidos por la quinta rueda; sin cabezote queda solo el del
    semirremolque, con sus patas de apoyo bajadas.
*/
class Articulado extends ModeloVehiculo {

    // Marca a las carrocerías que se pueden separar del cabezote:
    // `new Clase({ sinCabezote: true })` las dibuja sin él.
    static articulado = true;

    construirChasis() {

        const { carga: c, alturaPiso: p, radioRueda: r, portacontenedor } = this.esp;
        const acero = this.crearMaterial("#24272d", { roughness: 0.7, metalness: 0.4 });

        // Semirremolque: largueros, travesaños y barra trasera.
        for (const x of [-0.5, 0.5]) this.caja([0.16, 0.24, c.largo - 0.5], [x, p - 0.2, c.largo / 2], acero);
        for (let z = 0.9; z < c.largo - 0.5; z += 1.6) this.caja([c.ancho * 0.9, 0.1, 0.1], [0, p - 0.2, z], acero);
        this.caja([c.ancho * 0.9, 0.14, 0.14], [0, 0.6, 0.12], acero);

        // Portacontenedor: pivotes de sujeción en las cuatro esquinas.
        if (portacontenedor) {
            const pivote = this.crearMaterial("#d9a31a", { roughness: 0.5, metalness: 0.6 });
            for (const z of [0.3, c.largo - 0.3]) {
                for (const x of [-(c.ancho / 2 - 0.15), c.ancho / 2 - 0.15]) {
                    this.malla(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 10), [x, p + 0.02, z], pivote);
                }
            }
        }

        const zPatas = c.largo - (this.sinCabezote ? 2.6 : 3.4);
        this.construirPatas(zPatas, acero);

        // Faldones laterales aerodinámicos entre los ejes del
        // semirremolque y las patas.
        const faldon = this.crearMaterial("#2f343b", { roughness: 0.8, metalness: 0.2 });
        const ultimoEje = Math.max(...this.esp.ejes.filter((z) => z < c.largo - 2.5));
        const inicio = ultimoEje + 1.3;
        const largoFaldon = zPatas - 0.5 - inicio;
        if (largoFaldon > 0.5) {
            for (const lado of [-1, 1]) {
                this.caja([0.03, 0.34, largoFaldon], [lado * (c.ancho / 2 - 0.06), p - 0.32, inicio + largoFaldon / 2], faldon);
            }
        }

        if (this.sinCabezote) {
            // El pivote de la quinta rueda, a la vista.
            this.malla(new THREE.CylinderGeometry(0.05, 0.05, 0.2, 12), [0, p - 0.34, c.largo - 1.1], acero);
            this.caja([0.9, 0.06, 0.9], [0, p - 0.26, c.largo - 1.1], acero);
            return;
        }

        // Tractocamión.
        const desdeTracto = c.largo - 2.4;
        const largo = this.largoTotal - desdeTracto - 0.15;
        for (const x of [-0.45, 0.45]) this.caja([0.16, 0.28, largo], [x, r + 0.22, desdeTracto + largo / 2], acero);

        // Quinta rueda.
        const quinta = new THREE.Mesh(
            new THREE.CylinderGeometry(0.62, 0.62, 0.1, 28),
            this.crearMaterial("#11161d", { roughness: 0.5, metalness: 0.6 })
        );
        quinta.position.set(0, p - 0.38, c.largo - 1.1);
        quinta.castShadow = true;
        this.add(quinta);

        this.construirTanque(c.largo + this.esp.separacion - 0.2);
    }

    // Patas de apoyo del semirremolque (bajadas si está sin cabezote).
    construirPatas(z, acero) {

        const { alturaPiso: p } = this.esp;
        const alto = p - 0.3;
        const bajadas = this.sinCabezote;

        for (const x of [-0.6, 0.6]) {
            this.caja([0.12, alto, 0.12], [x, alto / 2 + 0.05, z], acero);
            if (bajadas) this.caja([0.34, 0.05, 0.34], [x, 0.03, z], acero);
        }
        if (!bajadas) return;

        this.caja([1.2, 0.07, 0.07], [0, alto * 0.45, z], acero);
        const manija = this.malla(new THREE.CylinderGeometry(0.018, 0.018, 0.36, 8).rotateZ(Math.PI / 2), [0.78, alto * 0.62, z], acero);
        manija.castShadow = false;
    }

    construirCabina() {

        super.construirCabina();
        if (this.sinCabezote) return;

        const { carga, separacion, cabina } = this.esp;
        const zc = carga.largo + separacion;
        const techo = this.pisoCabina + cabina.alto;
        const pintura = new THREE.MeshPhysicalMaterial({ color: this.colorCabina, roughness: 0.3, clearcoat: 0.8 });

        // Deflector de techo y exostos cromados.
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

/*
    Contenedor marítimo sobre el semirremolque: lámina corrugada
    en vertical, esquineros de acero, riel superior e inferior y
    puertas de dos hojas con sus cuatro barras de cierre.
*/
const ConContenedor = (Base) => class extends Base {

    construirFurgon() {

        const { carga: c, alturaPiso: p } = this.esp;
        const color = new THREE.Color(this.colorCarga);
        const acero = this.crearMaterial("#2b2f35", { roughness: 0.55, metalness: 0.7 });
        const cromo = this.crearMaterial("#b9bfc7", { roughness: 0.25, metalness: 1 });
        const junta = this.crearMaterial("#121418", { roughness: 0.9 });

        const pared = (repeticion) => {
            const m = this.crearMaterial(this.colorCarga, {
                roughness: 0.55, metalness: 0.3,
                bumpMap: repetir(relieveCorrugado(), repeticion, 1), bumpScale: 3.2
            });
            this.materialesParedes.push(m);
            return m;
        };

        // Piso de madera del contenedor.
        this.caja([c.ancho, 0.1, c.largo], [0, p - 0.05, c.largo / 2], this.crearMaterial("#5a4630", { roughness: 0.9 }));

        // Costados, frente y techo.
        const costado = pared(c.largo / 0.5);
        for (const lado of [-1, 1]) {
            this.caja([0.05, c.alto, c.largo], [lado * (c.ancho / 2 - 0.025), p + c.alto / 2, c.largo / 2], costado);
        }
        this.caja([c.ancho, c.alto, 0.05], [0, p + c.alto / 2, c.largo - 0.025], pared(c.ancho / 0.5));
        const techo = this.crearMaterial(color.clone().multiplyScalar(0.95), {
            roughness: 0.6, metalness: 0.3,
            bumpMap: repetir(relieveCorrugado(), c.ancho / 0.5, 1), bumpScale: 1.6
        });
        this.materialesParedes.push(techo);
        this.caja([c.ancho, 0.05, c.largo], [0, p + c.alto, c.largo / 2], techo);

        // Puertas de dos hojas.
        const puertas = pared(c.ancho / 0.5);
        this.caja([c.ancho, c.alto, 0.05], [0, p + c.alto / 2, 0.025], puertas);
        this.caja([0.015, c.alto, 0.03], [0, p + c.alto / 2, -0.01], junta);
        for (const lado of [-1, 1]) {
            for (const f of [0.3, 0.78]) {
                this.caja([0.035, c.alto * 0.94, 0.035], [lado * c.ancho * f / 2, p + c.alto / 2, -0.03], cromo);
                // Levas de cierre arriba y abajo de cada barra.
                for (const y of [p + c.alto * 0.07, p + c.alto * 0.93]) {
                    this.caja([0.09, 0.05, 0.05], [lado * c.ancho * f / 2, y, -0.045], acero);
                }
            }
            this.caja([0.03, 0.2, 0.05], [lado * c.ancho * 0.12, p + c.alto * 0.45, -0.05], acero);
        }

        // Riel inferior y superior, y postes con los esquineros.
        for (const lado of [-1, 1]) {
            for (const y of [p + 0.07, p + c.alto - 0.07]) {
                this.caja([0.12, 0.14, c.largo], [lado * (c.ancho / 2 - 0.03), y, c.largo / 2], acero);
            }
            for (const z of [0.07, c.largo - 0.07]) {
                this.caja([0.14, c.alto, 0.14], [lado * (c.ancho / 2 - 0.04), p + c.alto / 2, z], acero);
                for (const y of [p + 0.09, p + c.alto - 0.09]) {
                    this.caja([0.18, 0.18, 0.18], [lado * (c.ancho / 2 - 0.05), y, z], junta);
                }
            }
        }
        // Travesaño superior de las puertas y del frente.
        for (const z of [0.05, c.largo - 0.05]) this.caja([c.ancho, 0.1, 0.12], [0, p + c.alto - 0.05, z], acero);
    }
};


/* Colores de furgón de aluminio, para los que no son contenedor. */
const COLORES_FURGON = ["#e9ecef", "#d9dde3", "#cfd8e3", "#dfe3e8"];

export class MiniMula extends Articulado {

    static especificacion = {
        nombre: "Mini mula",
        carga: { largo: 9.2, ancho: 2.5, alto: 2.6 },
        alturaPiso: 1.25,
        cabina: { largo: 2.1, alto: 2.7, ancho: 2.4 },
        separacion: 0.8,
        // Tándem del semirremolque, eje motriz bajo la quinta rueda y
        // el direccional.
        ejes: [0.9, 2.2, 8.3, 11.2],
        radioRueda: 0.46
    };

    static coloresCarga = COLORES_FURGON;
}

export class TractomulaFurgon extends Articulado {

    static especificacion = {
        nombre: "Tractomula furgón",
        carga: { largo: 12.2, ancho: 2.55, alto: 2.7 },
        alturaPiso: 1.3,
        cabina: { largo: 2.3, alto: 2.9, ancho: 2.45 },
        separacion: 0.9,
        ejes: [0.9, 2.2, 3.5, 10.9, 12.2, 14.3],
        radioRueda: 0.5
    };

    static coloresCarga = COLORES_FURGON;
}

export class Tractomula extends ConContenedor(Articulado) {

    static especificacion = {
        nombre: "Tractomula",
        carga: { largo: 12.2, ancho: 2.55, alto: 2.7 },
        alturaPiso: 1.3,
        cabina: { largo: 2.3, alto: 2.9, ancho: 2.45 },
        separacion: 0.9,
        // Tres ejes del semirremolque atrás, dos del tractocamión
        // bajo la quinta rueda y el eje direccional adelante.
        ejes: [0.9, 2.2, 3.5, 10.9, 12.2, 14.3],
        radioRueda: 0.5,
        portacontenedor: true
    };

    // Contenedores de colores, como en cualquier patio de carga.
    static coloresCarga = ["#d9822b", "#b33a2e", "#2f65a8", "#c7cbd1", "#c9a23a", "#3e7a57"];
}


/* ---------------------------------------------------------
   VARIANTES DE CARROCERÍA
   Cada una cambia solo el furgón; chasis, cabina, ruedas y carga
   son los de su base. Sirven tanto para rígidos como articulados.
   --------------------------------------------------------- */

/*
    Refrigerado: furgón blanco con el equipo de frío (al frente si hay
    espacio detrás de la cabina; sobre el techo si no), franja azul y
    empaques de goma en las puertas.
*/
const ConRefrigeracion = (Base) => class extends Base {

    construirFurgon() {

        super.construirFurgon();

        const { carga: c, alturaPiso: p, separacion } = this.esp;
        const blanco = this.crearMaterial("#eef1f4", { roughness: 0.4, metalness: 0.3 });
        const rejilla = this.crearMaterial("#1b1e23", { roughness: 0.7 });
        const aspa = this.crearMaterial("#8f98a3", { roughness: 0.4, metalness: 0.7 });
        const goma = this.crearMaterial("#16181c", { roughness: 0.95 });
        const franja = this.crearMaterial("#1f6fc4", { roughness: 0.5 });

        // Franja azul a lo largo de los costados.
        for (const lado of [-1, 1]) {
            this.caja([0.012, 0.18, c.largo * 0.96], [lado * (c.ancho / 2 + 0.03), p + c.alto * 0.18, c.largo / 2], franja);
        }

        // Empaque de goma alrededor de las puertas.
        this.caja([c.ancho * 0.98, 0.07, 0.03], [0, p + c.alto - 0.03, -0.045], goma);
        for (const lado of [-1, 1]) this.caja([0.07, c.alto * 0.96, 0.03], [lado * (c.ancho / 2 - 0.1), p + c.alto / 2, -0.045], goma);

        // Equipo de frío.
        // Los articulados llevan el equipo al frente aunque estén sin
        // cabezote (entonces `separacion` es 0).
        const alAlfrente = !!this.constructor.articulado || separacion >= 0.6;
        const ancho = c.ancho * 0.66;
        const alto = alAlfrente ? 0.95 : 0.55;
        const fondo = alAlfrente ? 0.46 : 1.1;
        const z = alAlfrente ? c.largo + fondo / 2 : c.largo - fondo / 2 - 0.1;
        const y = alAlfrente ? p + c.alto - alto / 2 - 0.05 : p + c.alto + alto / 2;

        this.redondeada([ancho, alto, fondo], [0, y, z], blanco, 0.05);

        // Rejilla y dos ventiladores en la cara que mira atrás o adelante.
        const zCara = alAlfrente ? c.largo + fondo + 0.012 : c.largo - 0.1 + 0.012;
        this.caja([ancho * 0.84, alto * 0.7, 0.02], [0, y, zCara], rejilla);
        for (const dx of [-0.25, 0.25]) {
            const ventilador = new THREE.Mesh(new THREE.CylinderGeometry(alto * 0.26, alto * 0.26, 0.03, 20).rotateX(Math.PI / 2), aspa);
            ventilador.position.set(dx * ancho, y, zCara + 0.02);
            this.add(ventilador);
        }
    }
};

/*
    Estacas: plataforma abierta con barandas bajas, estacas y
    travesaños. La carga se ve completa (sin paredes que volver
    translúcidas).
*/
const ConEstacas = (Base) => class extends Base {

    // Va sobre la baranda, no sobre un furgón.
    zonaRotulo() {
        const { carga: c, alturaPiso: p } = this.esp;
        return { y: p + 0.3, alto: 0.34, largo: c.largo * 0.6, z: c.largo / 2 };
    }

    construirFurgon() {

        const { carga: c, alturaPiso: p } = this.esp;
        const acero = this.crearMaterial("#2b2f35", { roughness: 0.6, metalness: 0.6 });
        const madera = this.crearMaterial("#8a6a3d", { roughness: 0.95 });
        const pintura = this.crearMaterial(this.colorCarga, { roughness: 0.55, metalness: 0.3 });
        this.materialesParedes.push(pintura);

        const alto = c.alto * 0.92;
        const baranda = 0.5;

        // Piso de tablones.
        this.caja([c.ancho, 0.1, c.largo], [0, p - 0.05, c.largo / 2], madera);

        // Barandas bajas: costados, trasera y cabecera alta.
        for (const lado of [-1, 1]) {
            this.caja([0.05, baranda, c.largo], [lado * (c.ancho / 2 - 0.025), p + baranda / 2, c.largo / 2], pintura);
        }
        this.caja([c.ancho, baranda, 0.05], [0, p + baranda / 2, 0.025], pintura);
        this.caja([c.ancho, c.alto * 0.7, 0.06], [0, p + (c.alto * 0.7) / 2, c.largo - 0.03], pintura);

        // Estacas cada 1,2 m con su travesaño superior y uno intermedio.
        const n = Math.max(2, Math.round(c.largo / 1.2));
        for (let i = 0; i <= n; i++) {
            const z = 0.06 + (i / n) * (c.largo - 0.12);
            for (const lado of [-1, 1]) {
                this.caja([0.07, alto, 0.07], [lado * (c.ancho / 2 - 0.035), p + alto / 2, z], acero);
            }
        }
        for (const lado of [-1, 1]) {
            for (const f of [0.55, 1]) {
                this.caja([0.05, 0.05, c.largo], [lado * (c.ancho / 2 - 0.035), p + alto * f, c.largo / 2], acero);
            }
        }
        this.caja([c.ancho, 0.05, 0.05], [0, p + alto, 0.03], acero);
    }
};

/*
    Lona (cortina lateral): lona de color tensada sobre aros, con
    cinchas verticales y puertas de lona atrás.
*/
const ConLona = (Base) => class extends Base {

    construirFurgon() {

        const { carga: c, alturaPiso: p } = this.esp;
        const acero = this.crearMaterial("#2b2f35", { roughness: 0.6, metalness: 0.6 });
        const cincha = this.crearMaterial("#d6a516", { roughness: 0.8 });

        const lona = (repeticion) => {
            const m = this.crearMaterial(this.colorCarga, {
                roughness: 0.9, metalness: 0,
                bumpMap: repetir(relieveCorrugado(), repeticion, 1), bumpScale: 0.8
            });
            this.materialesParedes.push(m);
            return m;
        };

        this.caja([c.ancho, 0.12, c.largo], [0, p - 0.06, c.largo / 2], this.crearMaterial("#4b5058", { roughness: 0.9 }));

        const costado = lona(c.largo / 0.9);
        for (const lado of [-1, 1]) {
            this.caja([0.05, c.alto, c.largo], [lado * (c.ancho / 2 - 0.025), p + c.alto / 2, c.largo / 2], costado);
        }
        this.caja([c.ancho, c.alto, 0.05], [0, p + c.alto / 2, c.largo - 0.025], lona(c.ancho / 0.9));
        this.caja([c.ancho, c.alto, 0.05], [0, p + c.alto / 2, 0.025], lona(c.ancho / 0.9));
        const techo = lona(c.ancho / 0.9);
        this.caja([c.ancho, 0.05, c.largo], [0, p + c.alto, c.largo / 2], techo);

        // Cinchas verticales en los costados y en la puerta.
        const n = Math.max(3, Math.round(c.largo / 1.3));
        for (let i = 0; i <= n; i++) {
            const z = 0.12 + (i / n) * (c.largo - 0.24);
            for (const lado of [-1, 1]) {
                this.caja([0.012, c.alto * 0.96, 0.07], [lado * (c.ancho / 2 + 0.005), p + c.alto / 2, z], cincha);
            }
        }
        for (const x of [-0.3, 0, 0.3]) this.caja([0.07, c.alto * 0.96, 0.012], [x * c.ancho, p + c.alto / 2, -0.01], cincha);

        // Estructura: larguero superior e inferior y pilares.
        for (const lado of [-1, 1]) {
            for (const y of [p + 0.07, p + c.alto + 0.03]) {
                this.caja([0.1, 0.1, c.largo], [lado * (c.ancho / 2 - 0.03), y, c.largo / 2], acero);
            }
        }
        for (const x of [-1, 1]) {
            for (const z of [0.06, c.largo - 0.06]) {
                this.caja([0.1, c.alto, 0.1], [x * (c.ancho / 2 - 0.04), p + c.alto / 2, z], acero);
            }
        }
    }
};


export class Van extends ModeloVehiculo {
    static especificacion = {
        nombre: "Van / camioneta",
        carga: { largo: 2.8, ancho: 1.8, alto: 1.7 },
        alturaPiso: 0.8,
        cabina: { largo: 1.3, alto: 1.6, ancho: 1.8 },
        separacion: 0.08,
        ejes: [0.65, 3.4],
        radioRueda: 0.31
    };
    static coloresCarga = ["#f1f3f5", "#e3e6ea", "#c9d3df"];
}

export class Refrigerado extends ConRefrigeracion(ModeloVehiculo) {
    static especificacion = { ...Sencillo.especificacion, nombre: "Camión refrigerado" };
    static coloresCarga = ["#eef1f4", "#e6eaee"];
}

export class Estacas extends ConEstacas(ModeloVehiculo) {
    static especificacion = { ...Sencillo.especificacion, nombre: "Camión de estacas" };
    static coloresCarga = ["#2f65a8", "#b33a2e", "#3e7a57", "#c9a23a"];
}

export class Lona extends ConLona(ModeloVehiculo) {
    static especificacion = { ...DobleTroque.especificacion, nombre: "Camión de lona" };
    static coloresCarga = ["#1f4e8c", "#a8322a", "#2f6e3f", "#3b3f46"];
}

export class TractomulaRefrigerada extends ConRefrigeracion(Articulado) {
    static especificacion = { ...TractomulaFurgon.especificacion, nombre: "Tractomula refrigerada" };
    static coloresCarga = ["#eef1f4", "#e6eaee"];
}

export class TractomulaLona extends ConLona(Articulado) {
    static especificacion = { ...TractomulaFurgon.especificacion, nombre: "Tractomula de lona" };
    static coloresCarga = ["#1f4e8c", "#a8322a", "#2f6e3f", "#3b3f46", "#c8cdd4"];
}

export class TractomulaPlataforma extends ConEstacas(Articulado) {
    static especificacion = { ...TractomulaFurgon.especificacion, nombre: "Tractomula plataforma" };
    static coloresCarga = ["#2f65a8", "#b33a2e", "#3e7a57", "#c9a23a"];
}


/* ---------------------------------------------------------
   SIN CABEZOTE
   --------------------------------------------------------- */

const SIN_CABEZOTE = {
    carga: { largo: 12.2, ancho: 2.55, alto: 2.7 },
    alturaPiso: 1.3,
    cabina: { largo: 0, alto: 0, ancho: 0 },
    separacion: 0,
    sinCabezote: true,
    ejes: [0.9, 2.2, 3.5],
    radioRueda: 0.5
};

// Furgón de carrocería parqueado sin el tractocamión.
export class SemirremolqueSinCabezote extends Articulado {
    static especificacion = { ...SIN_CABEZOTE, nombre: "Semirremolque (sin cabezote)" };
    static coloresCarga = COLORES_FURGON;
}

// Solo el contenedor con su chasis portacontenedor.
export class ContenedorSinCabezote extends ConContenedor(Articulado) {
    static especificacion = { ...SIN_CABEZOTE, nombre: "Contenedor (sin cabezote)", portacontenedor: true };
    static coloresCarga = ["#d9822b", "#b33a2e", "#2f65a8", "#c7cbd1", "#c9a23a", "#3e7a57"];
}
