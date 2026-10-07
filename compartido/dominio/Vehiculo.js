/* =========================================================
   INLOTRANS
   Vehículo

   Envuelve el registro tal como se guarda (mismos nombres de
   campo que en Firestore: tipo, avanceTipo, avancePorcentaje,
   numeroMuelle...) y expone las preguntas que hoy están
   regadas en funciones sueltas de vehiculos.js.

   Es inmutable: los cambios devuelven un Vehiculo nuevo. Así
   React detecta el cambio y el 3D se vuelve a animar solo.
   ========================================================= */

import { MODALIDAD_POR_DEFECTO, MULTIPLICADOR_URGENTE } from "./Tipologia.js";

// Mismos valores que shared/services/vehiculos.js de la app actual.
export const MINIMO_SALIDA = 100;
export const MINIMO_CARGUE_ANTICIPADO = 95;

export class Vehiculo {

    #datos;

    constructor(datos, tipologia = null) {
        this.#datos = Object.freeze({ ...datos });
        this.tipologia = tipologia;
    }

    get id() { return this.#datos.id; }
    get placa() { return this.#datos.placa || ""; }
    get tipoOperacion() { return this.#datos.tipo; }
    get modalidad() { return this.#datos.modalidad || MODALIDAD_POR_DEFECTO; }
    get numeroMuelle() { return this.#datos.numeroMuelle ?? null; }
    get datos() { return this.#datos; }

    get enMuelle() {
        if (this.#datos.horaSalida) return false;
        if (this.#datos.ubicacion) return this.#datos.ubicacion === "Muelle";
        return this.numeroMuelle !== null && this.numeroMuelle !== "";
    }

    // "Ambos" hace las dos, y el descargue va siempre primero.
    get fases() {
        return this.tipoOperacion === "Ambos" ? ["Descargue", "Cargue"] : [this.tipoOperacion];
    }

    // La fase que se está midiendo. Un "Ambos" sin fase elegida
    // se trata como descargue, igual que minimoDe().
    get fase() {
        return this.#datos.avanceTipo || this.fases[0];
    }

    get porcentaje() {
        return Math.min(100, Math.max(0, Number(this.#datos.avancePorcentaje) || 0));
    }

    // Le queda el cargue por hacer después de este descargue.
    get faltaCargue() {
        return this.tipoOperacion === "Ambos" && this.fase === "Descargue";
    }

    /*
        Qué tan lleno está el furgón (0 a 1): lo que dibuja el 3D.

        No es el porcentaje: un descargue al 30 % tiene el 70 % de
        la mercancía todavía adentro. Un cargue al 30 % tiene el
        30 %. Si el tablero pintara el porcentaje tal cual, los
        descargues se verían llenarse en vez de vaciarse.
    */
    get ocupacion() {
        const p = this.porcentaje / 100;
        return this.fase === "Cargue" ? p : 1 - p;
    }

    get modelo3d() {
        return this.tipologia?.modelo3d;
    }

    metaMinutos() {
        return this.tipologia?.metaPara(this.fase, this.modalidad) ?? null;
    }

    /*
        Cómo va contra la meta de su tipología: "ok", "atencion"
        (pasó la meta) o "urgente" (la dobló). null si no hay meta
        contra qué medir — sin tipología no hay alerta.
    */
    nivelTiempo(minutosEnMuelle) {
        const meta = this.metaMinutos();
        if (!meta) return null;
        if (minutosEnMuelle >= meta * MULTIPLICADOR_URGENTE) return "urgente";
        if (minutosEnMuelle >= meta) return "atencion";
        return "ok";
    }

    /* ---------------------------------------------------------
       SALIDA

       Las mismas reglas de la app actual: sin clasificar no
       sale, y sin terminar la operación tampoco — salvo el
       cargue que va en el mínimo anticipado y que el supervisor
       autorizó. Un "Ambos" que va en descargue no ha terminado
       aunque el descargue esté al 100 %: le falta cargar.
       --------------------------------------------------------- */

    minimoSalida(config) {
        return this.fase === "Cargue"
            ? config?.minimoCargue ?? MINIMO_CARGUE_ANTICIPADO
            : config?.minimoDescargue ?? MINIMO_SALIDA;
    }

    get terminado() {
        return this.fase === this.fases[this.fases.length - 1] && this.porcentaje >= MINIMO_SALIDA;
    }

    puedeAutorizarSalidaAnticipada(config) {
        if (this.terminado || this.faltaCargue || this.#datos.salidaAutorizada) return false;
        const minimo = this.minimoSalida(config);
        return minimo < MINIMO_SALIDA && this.porcentaje >= minimo;
    }

    // null = puede salir; si no, el motivo para mostrarle al usuario.
    bloqueoSalida(config) {

        if (!this.tipologia) return "Falta asignarle la tipología";
        if (this.terminado) return null;

        if (this.faltaCargue) return `Va en descargue (${this.porcentaje} %) y después le falta el cargue`;
        if (this.#datos.salidaAutorizada && this.porcentaje >= this.minimoSalida(config)) return null;

        return `${this.fase} en ${this.porcentaje} %: necesita ${MINIMO_SALIDA} %` +
            (this.puedeAutorizarSalidaAnticipada(config) ? " o autorización del supervisor" : "");
    }

    con(cambios) {
        return new Vehiculo({ ...this.#datos, ...cambios }, this.tipologia);
    }

    conAvance(fase, porcentaje) {
        return new Vehiculo(
            { ...this.#datos, avanceTipo: fase, avancePorcentaje: porcentaje },
            this.tipologia
        );
    }
}
