/* =========================================================
   INLOTRANS
   Modelo 3D de vehículo — clase base

   Cada carrocería (Turbo, Sencillo, Doble troque, Tractomula)
   hereda de aquí y declara sus medidas en `static
   especificacion`. Las que tienen una forma distinta, como la
   tractomula articulada, sobrescriben solo el paso de
   construcción que cambia.

   Ejes locales: la puerta trasera del furgón está en z = 0 y el
   vehículo crece hacia +z (la cabina queda adelante). Para
   arrimarlo a un muelle basta con llevar su z a la cara del
   muro: el muelle siempre recibe por la puerta trasera.

   Medidas en metros. Todo es geometría generada: cuando
   lleguen los .glb de Blender, una subclase puede cargar el
   modelo en construirCabina()/construirFurgon() y el resto
   (carga, ruedas, avance, animaciones) sigue igual.
   ========================================================= */

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { animate } from "motion";

import { relieveCorrugado, repetir } from "../texturas.js";

// Una estiba estándar colombiana: 1,0 × 1,2 m.
const ESTIBA = { ancho: 1.0, largo: 1.2, base: 0.15 };

const RESORTE = { type: "spring", stiffness: 60, damping: 18 };

const TONOS_CARTON = ["#c9a46c", "#b98f58", "#d6b582", "#bf9a63"];

export class ModeloVehiculo extends THREE.Group {

    // Las subclases la reemplazan completa.
    static especificacion = {
        nombre: "Vehículo",
        carga: { largo: 6, ancho: 2.4, alto: 2.4 },
        alturaPiso: 1.15,
        cabina: { largo: 1.9, alto: 2.4, ancho: 2.3 },
        separacion: 0.15,
        ejes: [1.4, 7],          // el último es el direccional
        radioRueda: 0.5
    };

    // Furgones de carrocería: aluminio claro. La tractomula lleva
    // contenedores de colores (ver carrocerias.js).
    static coloresCarga = ["#d9dde3", "#c8cdd4", "#e6e8ec"];
    static coloresCabina = ["#eef0f3", "#eef0f3", "#1f4e8c", "#eef0f3", "#a8322a"];

    /*
        `semilla` elige colores de las listas de arriba: el mismo
        vehículo sale siempre igual, y vehículos distintos no
        salen todos idénticos.
    */
    constructor({ semilla = 0 } = {}) {

        super();

        const Clase = this.constructor;
        this.esp = Clase.especificacion;
        this.colorCabina = Clase.coloresCabina[semilla % Clase.coloresCabina.length];
        this.colorCarga = Clase.coloresCarga[semilla % Clase.coloresCarga.length];

        // Lo que Motion anima. El dibujo se actualiza en tick(),
        // una vez por cuadro, leyendo estos valores.
        this.estado = { ocupacion: 0, avance: 0, opacidad: 1 };

        this.estibas = [];
        this.ruedas = [];
        this.materialesParedes = [];
        this.rellenosAvance = [];
        this.anterior = null;        // posición del cuadro anterior (ruedas)
        this.movimientos = new Set(); // animaciones del recorrido en curso
        this.turnoRecorrido = 0;
        this.animaciones = new Set();

        this.construir();
    }

    get largoTotal() {
        const { carga, separacion, cabina } = this.esp;
        return carga.largo + separacion + cabina.largo;
    }

    get pisoCabina() {
        return this.esp.radioRueda + 0.32;
    }

    get xRueda() {
        return this.esp.carga.ancho / 2 - 0.32;
    }

    /* ---------------------------------------------------------
       CONSTRUCCIÓN — cada paso se puede sobrescribir
       --------------------------------------------------------- */

    construir() {
        this.construirChasis();
        this.construirCabina();
        this.construirFurgon();
        this.construirRuedas();
        this.construirCarga();
        this.construirIndicadorAvance();
    }

    construirChasis() {

        const { radioRueda, carga } = this.esp;
        const acero = this.crearMaterial("#24272d", { roughness: 0.7, metalness: 0.4 });
        const y = radioRueda + 0.2;
        const largo = this.largoTotal - 0.5;

        for (const x of [-0.45, 0.45]) this.caja([0.16, 0.28, largo], [x, y, 0.25 + largo / 2], acero);
        for (let z = 0.8; z < largo; z += 1.7) this.caja([0.9, 0.12, 0.12], [0, y, z], acero);

        // Barra antiempotramiento trasera.
        this.caja([carga.ancho * 0.9, 0.14, 0.14], [0, 0.55, 0.12], acero);

        this.construirTanque(this.esp.carga.largo + this.esp.separacion - 0.8);
    }

    construirTanque(z) {
        const tanque = new THREE.Mesh(
            new THREE.CylinderGeometry(0.28, 0.28, 1.1, 24).rotateX(Math.PI / 2),
            this.crearMaterial("#c4c9d0", { roughness: 0.25, metalness: 1 })
        );
        tanque.position.set(-(this.esp.carga.ancho / 2 - 0.42), this.pisoCabina - 0.05, z);
        tanque.castShadow = true;
        this.add(tanque);
    }

    construirCabina() {

        const { carga, separacion, cabina, ejes, radioRueda } = this.esp;
        const { ancho: W, alto: H, largo: L } = cabina;
        const zc = carga.largo + separacion + L / 2;
        const zf = zc + L / 2;
        const piso = this.pisoCabina;
        const hBajo = H * 0.34;
        const hAlto = H - hBajo;

        const pintura = new THREE.MeshPhysicalMaterial({
            color: this.colorCabina, roughness: 0.3, metalness: 0.1, clearcoat: 0.8, clearcoatRoughness: 0.15
        });
        const negro = this.crearMaterial("#1c1f24", { roughness: 0.6 });
        const vidrio = new THREE.MeshPhysicalMaterial({ color: "#16202b", roughness: 0.05, metalness: 0.3, clearcoat: 1 });
        const cromo = this.crearMaterial("#cfd4db", { roughness: 0.15, metalness: 1 });

        // Cuerpo: parte baja y habitáculo, con aristas redondeadas.
        this.redondeada([W, hBajo, L], [0, piso + hBajo / 2, zc], pintura, 0.12);
        this.redondeada([W, hAlto, L * 0.97], [0, piso + hBajo + hAlto / 2, zc - L * 0.015], pintura, 0.22);

        // Parabrisas y ventanas.
        const parabrisas = this.caja([W * 0.86, hAlto * 0.5, 0.05], [0, piso + hBajo + hAlto * 0.58, zf - 0.03], vidrio);
        parabrisas.rotation.x = -0.07;
        for (const lado of [-1, 1]) {
            this.caja([0.04, hAlto * 0.4, L * 0.4], [lado * (W / 2 + 0.004), piso + hBajo + hAlto * 0.6, zf - L * 0.3], vidrio);
        }

        // Rejilla con lamas cromadas.
        this.caja([W * 0.62, hBajo * 0.6, 0.04], [0, piso + hBajo * 0.55, zf + 0.005], negro);
        for (let i = 0; i < 4; i++) {
            this.caja([W * 0.58, 0.035, 0.03], [0, piso + hBajo * 0.32 + i * hBajo * 0.13, zf + 0.03], cromo);
        }

        // Parachoques y farolas.
        this.redondeada([W * 1.02, 0.32, 0.42], [0, piso - 0.04, zf - 0.04], this.crearMaterial("#3a3f47", { roughness: 0.45, metalness: 0.4 }), 0.08);
        const luz = new THREE.MeshStandardMaterial({ color: "#fff6e0", emissive: "#fff1cf", emissiveIntensity: 2 });
        for (const lado of [-1, 1]) this.caja([0.36, 0.13, 0.04], [lado * (W / 2 - 0.3), piso + 0.04, zf + 0.18], luz);

        // Espejos.
        for (const lado of [-1, 1]) {
            this.caja([0.34, 0.04, 0.04], [lado * (W / 2 + 0.17), piso + hBajo + hAlto * 0.62, zf - 0.12], negro);
            this.redondeada([0.1, 0.44, 0.16], [lado * (W / 2 + 0.34), piso + hBajo + hAlto * 0.52, zf - 0.12], negro, 0.03);
        }

        // Visera y guardafangos de la rueda delantera.
        this.caja([W * 0.92, 0.06, 0.26], [0, piso + H - 0.1, zf + 0.06], negro);
        const zEje = ejes[ejes.length - 1];
        for (const lado of [-1, 1]) {
            this.redondeada([0.46, 0.1, radioRueda * 2 + 0.35], [lado * this.xRueda, radioRueda * 2 + 0.12, zEje], negro, 0.04);
        }
    }

    /*
        El furgón: lámina corrugada con marco. Las paredes pueden
        volverse translúcidas (verInterior) para mostrar la carga;
        el marco se queda sólido y conserva la forma.
    */
    construirFurgon() {

        const { carga: c, alturaPiso: p } = this.esp;
        const color = new THREE.Color(this.colorCarga);
        const marco = this.crearMaterial(color.clone().multiplyScalar(0.55), { roughness: 0.5, metalness: 0.5 });

        const pared = (repeticion) => {
            const m = this.crearMaterial(this.colorCarga, {
                roughness: 0.5, metalness: 0.35,
                bumpMap: repetir(relieveCorrugado(), repeticion, 1), bumpScale: 2.5
            });
            this.materialesParedes.push(m);
            return m;
        };

        // Piso de la caja.
        this.caja([c.ancho, 0.12, c.largo], [0, p - 0.06, c.largo / 2], this.crearMaterial("#4b5058", { roughness: 0.9 }));

        // Costados, frente, techo y puertas.
        const costado = pared(c.largo / 1.2);
        for (const lado of [-1, 1]) {
            this.caja([0.05, c.alto, c.largo], [lado * (c.ancho / 2 - 0.025), p + c.alto / 2, c.largo / 2], costado);
        }
        this.caja([c.ancho, c.alto, 0.05], [0, p + c.alto / 2, c.largo - 0.025], pared(c.ancho / 1.2));

        const techo = this.crearMaterial(color.clone().multiplyScalar(1.05), { roughness: 0.6, metalness: 0.3 });
        this.materialesParedes.push(techo);
        this.caja([c.ancho, 0.05, c.largo], [0, p + c.alto, c.largo / 2], techo);

        const puertas = pared(c.ancho / 1.2);
        this.caja([c.ancho, c.alto, 0.05], [0, p + c.alto / 2, 0.025], puertas);

        // Barras de cierre de las puertas.
        const cromo = this.crearMaterial("#b9bfc7", { roughness: 0.25, metalness: 1 });
        for (const x of [-0.75, -0.35, 0.35, 0.75]) {
            this.caja([0.035, c.alto * 0.92, 0.035], [x * c.ancho / 2.4, p + c.alto / 2, -0.02], cromo);
        }

        // Marco: largueros arriba y abajo, y postes en las esquinas.
        for (const lado of [-1, 1]) {
            for (const y of [p + 0.06, p + c.alto - 0.04]) {
                this.caja([0.1, 0.14, c.largo], [lado * (c.ancho / 2 - 0.03), y, c.largo / 2], marco);
            }
            for (const z of [0.06, c.largo - 0.06]) {
                this.caja([0.12, c.alto, 0.12], [lado * (c.ancho / 2 - 0.04), p + c.alto / 2, z], marco);
            }
        }
    }

    construirRuedas() {

        const { ejes, radioRueda: r } = this.esp;

        const geoLlanta = new THREE.CylinderGeometry(r, r, 0.32, 32).rotateZ(Math.PI / 2);
        const geoRin = new THREE.CylinderGeometry(r * 0.58, r * 0.58, 0.34, 24).rotateZ(Math.PI / 2);
        const geoBuje = new THREE.CylinderGeometry(r * 0.16, r * 0.2, 0.38, 12).rotateZ(Math.PI / 2);
        const llanta = this.crearMaterial("#17191d", { roughness: 0.92 });
        const rin = this.crearMaterial("#b6bcc4", { roughness: 0.3, metalness: 0.85 });
        const buje = this.crearMaterial("#5d636b", { roughness: 0.4, metalness: 0.8 });

        ejes.forEach((z, i) => {

            // Todos los ejes llevan rueda doble menos el direccional.
            const doble = i < ejes.length - 1;

            for (const lado of [-1, 1]) {

                const rueda = new THREE.Group();
                rueda.position.set(lado * this.xRueda, r, z);

                const exterior = new THREE.Mesh(geoLlanta, llanta);
                const aro = new THREE.Mesh(geoRin, rin);
                const centro = new THREE.Mesh(geoBuje, buje);
                aro.position.x = centro.position.x = lado * 0.01;
                rueda.add(exterior, aro, centro);

                if (doble) {
                    const interior = new THREE.Mesh(geoLlanta, llanta);
                    interior.position.x = -lado * 0.34;
                    rueda.add(interior);
                }

                rueda.traverse((m) => (m.castShadow = true));
                this.add(rueda);
                this.ruedas.push(rueda);
            }
        });
    }

    /*
        Las estibas, ordenadas de adelante (junto a la cabina)
        hacia la puerta: se cargan desde el fondo y se descargan
        empezando por la puerta, así que en los dos casos la
        mercancía que queda está siempre al fondo.
    */
    construirCarga() {

        const { carga, alturaPiso } = this.esp;

        const porAncho = Math.max(1, Math.floor(carga.ancho / (ESTIBA.ancho + 0.05)));
        const porLargo = Math.max(1, Math.floor(carga.largo / (ESTIBA.largo + 0.05)));
        const niveles = carga.alto >= 2.5 ? 2 : 1;
        const altoBulto = (carga.alto * 0.86) / niveles - ESTIBA.base;

        // Estiba de madera: tres patines y la cubierta, en una sola
        // geometría. Todo con el origen en la base, para que escalar
        // en y las haga crecer desde el piso.
        const geoEstiba = mergeGeometries([
            ...[-0.42, 0, 0.42].map((x) => new THREE.BoxGeometry(0.1, 0.1, ESTIBA.largo).translate(x, 0.05, 0)),
            new THREE.BoxGeometry(ESTIBA.ancho, 0.04, ESTIBA.largo).translate(0, 0.12, 0)
        ]);
        const geoBulto = new RoundedBoxGeometry(ESTIBA.ancho * 0.96, altoBulto, ESTIBA.largo * 0.96, 2, 0.05)
            .translate(0, ESTIBA.base + altoBulto / 2, 0);

        const madera = this.crearMaterial("#9a6f3a", { roughness: 1 });
        const tonos = TONOS_CARTON.map((c) => this.crearMaterial(c, { roughness: 0.75 }));

        const pasoX = carga.ancho / porAncho;
        const pasoZ = carga.largo / porLargo;
        let n = 0;

        for (let col = porLargo - 1; col >= 0; col--) {
            for (let nivel = 0; nivel < niveles; nivel++) {
                for (let fila = 0; fila < porAncho; fila++) {

                    const estiba = new THREE.Group();
                    estiba.add(new THREE.Mesh(geoEstiba, madera), new THREE.Mesh(geoBulto, tonos[n++ % tonos.length]));
                    estiba.children.forEach((m) => { m.castShadow = true; m.receiveShadow = true; });

                    estiba.position.set(
                        -carga.ancho / 2 + pasoX * (fila + 0.5),
                        alturaPiso + nivel * (altoBulto + ESTIBA.base),
                        pasoZ * (col + 0.5)
                    );
                    estiba.scale.setScalar(0);
                    estiba.visible = false;

                    this.add(estiba);
                    this.estibas.push(estiba);
                }
            }
        }
    }

    /*
        Franja de avance en los dos costados del furgón: se ve de
        lejos aunque las paredes estén cerradas. Crece desde la
        puerta hacia la cabina con el color de la fase.
    */
    construirIndicadorAvance() {

        const { carga: c, alturaPiso: p } = this.esp;
        const largo = c.largo * 0.86;
        const z0 = c.largo * 0.07;
        const y = p + 0.42;

        const fondo = this.crearMaterial("#0f141b", { roughness: 0.6 });
        this.materialRelleno = new THREE.MeshStandardMaterial({ color: "#3987e5", emissive: "#3987e5", emissiveIntensity: 1.3 });
        const geoRelleno = new THREE.BoxGeometry(0.03, 0.16, largo).translate(0, 0, largo / 2);

        for (const lado of [-1, 1]) {
            const x = lado * (c.ancho / 2 + 0.02);
            this.caja([0.025, 0.22, largo + 0.06], [x, y, z0 + largo / 2], fondo).castShadow = false;

            const relleno = new THREE.Mesh(geoRelleno, this.materialRelleno);
            relleno.position.set(x + lado * 0.01, y, z0);
            relleno.scale.z = 0.0001;
            this.add(relleno);
            this.rellenosAvance.push(relleno);
        }
    }

    /* ---------------------------------------------------------
       COMPORTAMIENTO
       --------------------------------------------------------- */

    // 0 = vacío, 1 = lleno. Motion lo lleva con resorte.
    mostrarOcupacion(fraccion) {
        this.animar(this.estado, { ocupacion: Math.min(1, Math.max(0, fraccion)) }, RESORTE);
    }

    mostrarAvance(porcentaje, color) {
        this.materialRelleno.color.set(color);
        this.materialRelleno.emissive.set(color);
        this.animar(this.estado, { avance: Math.min(1, Math.max(0, porcentaje / 100)) }, RESORTE);
    }

    // Paredes translúcidas para ver la carga ("rayos X").
    verInterior(activo) {
        this.animar(this.estado, { opacidad: activo ? 0.14 : 1 }, { duration: 0.6, ease: [0.16, 1, 0.3, 1] });
    }

    // Pone el vehículo en un sitio sin animar (al abrir la página).
    colocar(x, z, rumbo = 0) {
        this.detenerRecorrido();
        this.position.set(x, 0, z);
        this.rotation.y = rumbo;
        this.anterior = null;
    }

    detenerRecorrido() {
        this.turnoRecorrido = (this.turnoRecorrido || 0) + 1;
        for (const m of this.movimientos || []) m.stop();
        this.movimientos = new Set();
    }

    /*
        Lleva el vehículo por una lista de puntos [x, z].

        En los tramos a lo largo de x gira para mirar hacia donde va
        (por el carril, con la cabina adelante). En los tramos a lo
        largo de z queda derecho: de frente hacia el patio o en
        reversa hacia el muelle, que es como se arrima de verdad.

        Si llega otro recorrido a mitad de camino, este se abandona
        y devuelve false.
    */
    async recorrer(puntos, { velocidad = 9 } = {}) {

        this.detenerRecorrido();
        const turno = this.turnoRecorrido;
        const vigente = () => turno === this.turnoRecorrido;

        const mover = (objeto, valores, opciones) => {
            const control = this.animar(objeto, valores, opciones);
            this.movimientos.add(control);
            return control.finished;
        };

        for (let i = 0; i < puntos.length; i++) {

            const [x, z] = puntos[i];
            const dx = x - this.position.x;
            const dz = z - this.position.z;
            const distancia = Math.hypot(dx, dz);
            if (distancia < 0.05) continue;

            const rumbo = Math.abs(dx) > Math.abs(dz) ? Math.atan2(dx, dz) : 0;
            const giro = Math.atan2(Math.sin(rumbo - this.rotation.y), Math.cos(rumbo - this.rotation.y));

            if (Math.abs(giro) > 0.01) {
                await mover(this.rotation, { y: this.rotation.y + giro }, { duration: 0.8, ease: "easeInOut" });
                if (!vigente()) return false;
            }

            const ultimo = i === puntos.length - 1;
            await mover(this.position, { x, z }, {
                duration: Math.max(0.9, distancia / velocidad),
                ease: ultimo ? [0.25, 0.1, 0.15, 1] : "easeInOut"
            });
            if (!vigente()) return false;
        }

        return true;
    }

    // Se llama en cada cuadro (useFrame).
    tick() {

        const { ocupacion, avance, opacidad } = this.estado;

        // Cada estiba se llena en su turno: con 10 estibas y la
        // ocupación en 0,35, las 3 primeras están completas y la
        // cuarta va a la mitad. Así el avance se ve fluido y no a
        // saltos de una estiba entera.
        const llenas = ocupacion * this.estibas.length;
        this.estibas.forEach((estiba, i) => {
            const f = Math.min(1, Math.max(0, llenas - i));
            estiba.visible = f > 0.001;
            estiba.scale.set(0.7 + 0.3 * f, f, 0.7 + 0.3 * f);
        });

        for (const r of this.rellenosAvance) r.scale.z = Math.max(0.0001, avance);

        const translucido = opacidad < 0.99;
        for (const m of this.materialesParedes) {
            if (m.transparent !== translucido) {
                m.transparent = translucido;
                m.depthWrite = !translucido;
                m.needsUpdate = true;
            }
            m.opacity = opacidad;
        }

        // Las ruedas giran lo que el vehículo avanzó en la dirección
        // en que mira (negativo en reversa).
        const { x, z } = this.position;
        if (this.anterior) {
            const rumbo = this.rotation.y;
            const avance = (x - this.anterior.x) * Math.sin(rumbo) + (z - this.anterior.z) * Math.cos(rumbo);
            const giro = avance / this.esp.radioRueda;
            for (const rueda of this.ruedas) rueda.rotation.x += giro;
        }
        this.anterior = { x, z };
    }

    dispose() {
        this.detenerRecorrido();
        for (const a of this.animaciones) a.stop();
        this.traverse((o) => {
            o.geometry?.dispose();
            if (o.material) {
                o.material.bumpMap?.dispose();
                o.material.dispose();
            }
        });
    }

    /* ---------------------------------------------------------
       AYUDANTES
       --------------------------------------------------------- */

    animar(objeto, valores, opciones) {
        const control = animate(objeto, valores, opciones);
        this.animaciones.add(control);
        control.finished.then(() => this.animaciones.delete(control));
        return control;
    }

    crearMaterial(color, opciones = {}) {
        return new THREE.MeshStandardMaterial({ color, ...opciones });
    }

    caja(tamano, posicion, material) {
        return this.malla(new THREE.BoxGeometry(...tamano), posicion, material);
    }

    redondeada(tamano, posicion, material, radio = 0.1) {
        return this.malla(new RoundedBoxGeometry(...tamano, 3, radio), posicion, material);
    }

    malla(geometria, posicion, material) {
        const m = new THREE.Mesh(geometria, material);
        m.position.set(...posicion);
        m.castShadow = true;
        m.receiveShadow = true;
        this.add(m);
        return m;
    }
}
