/* =========================================================
   INLOTRANS
   Cobro a los vehículos (Firestore)

   Solo aplica en las bodegas cuya configuración tiene
   `cobraVehiculos` en true — hoy únicamente J4. En las demás,
   las tipologías existen para medir tiempos y aquí no se
   escribe nada.

   ── POR QUÉ ESTA COLECCIÓN EXISTE APARTE ──

   El monto y el medio de pago son datos sensibles que el
   operario de portería no debe ver. Las reglas de Firestore
   autorizan documentos completos, no campos: si esto viviera
   dentro del documento del vehículo, el operario —que está
   obligado a leerlo entero para trabajar— se lo llevaría de
   paso, y ocultarlo en la interfaz sería puro adorno.

   Por eso el reparto es:

     cobros/{vehiculoId}      monto, medio, quién cobró.
                              Solo supervisor y administrador.

     vehiculos/{id}.pagoRegistrado
                              un booleano, nada más. Es lo único
                              que el operario necesita para saber
                              si puede despachar, y no revela ni
                              cuánto ni cómo se pagó.

   El id del documento es el id del vehículo: un vehículo, un
   cobro. Buscar el cobro de un vehículo no necesita consulta.
   ========================================================= */

import {
    collection,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    query,
    where,
    onSnapshot,
    arrayUnion,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { db } from "../core/firebase.js";
import { nowLocal } from "../utils/tiempos.js";

const COLECCION = "cobros";
const COLECCION_VEHICULOS = "vehiculos";


/* =========================================================
   MEDIOS DE PAGO

   "Ambos" es un medio por derecho propio, no la suma de los
   otros dos. Un vehículo que paga mitad y mitad es UNA
   transacción, y en los indicadores aparece en su propia
   casilla: si se repartiera entre Efectivo y QR, el conteo de
   vehículos por medio dejaría de cuadrar con el de vehículos
   cobrados, y nadie sabría cuáles pagaron mezclado.
   ========================================================= */

export const MEDIOS_PAGO = ["Efectivo", "QR", "Ambos"];

export function esMedioValido(medio) {
    return MEDIOS_PAGO.indexOf(medio) !== -1;
}


/* =========================================================
   SOPORTE DE PAGO

   Qué papel se le entrega al conductor. Es OTRA COSA que el
   medio de pago —un vehículo puede pagar por QR y llevarse una
   factura— y por eso son dos campos y no uno.

   Importa porque decide cuánto se cobra:

       Recibo Caja Menor    el valor ANTES de IVA
       Factura              el valor CON IVA
       Facturado al cliente el valor CON IVA, pero no entra plata
                            a portería: se le carga al cliente

   El recibo de caja menor no discrimina impuesto, así que ahí se
   cobra la tarifa limpia; la factura sí lo liquida y por eso
   cobra el total. Las dos cifras salen de la misma tarifa
   configurada, no son dos tarifas distintas.
   ========================================================= */

export const SOPORTES_PAGO = ["Recibo Caja Menor", "Factura", "Facturado al cliente"];

export const SOPORTE_POR_DEFECTO = "Recibo Caja Menor";

export function esSoporteValido(soporte) {
    return SOPORTES_PAGO.indexOf(soporte) !== -1;
}

/* Lo facturado al cliente no pasa por la caja de portería: no hay
   medio de pago que elegir ni monto que repartir, y no puede
   sumarse al arqueo del turno. */
export function soporteEntraACaja(soporte) {
    return soporte !== "Facturado al cliente";
}

/*
    Cuánto se le cobra a este vehículo, según el papel que se le
    entrega. Recibe el desglose que arma config.desglosarTarifa().
*/
export function tarifaDeSoporte(desglose, soporte) {
    if (!desglose) return 0;
    return soporte === SOPORTE_POR_DEFECTO
        ? (Number(desglose.base) || 0)
        : (Number(desglose.conIva) || 0);
}

/* El IVA que efectivamente se liquidó. Con recibo de caja menor
   no se cobró impuesto, así que es cero — y esa es la cifra que
   se concilia, no el IVA teórico de la tabla. */
export function ivaCobradoDe(desglose, soporte) {
    return soporte === SOPORTE_POR_DEFECTO ? 0 : (Number(desglose && desglose.iva) || 0);
}


/* =========================================================
   REPARTO DEL MONTO

   La tarifa la fija la tipología, así que los dos montos no son
   libres: tienen que sumarla exactamente. Por eso solo se
   captura el efectivo y el QR se deduce — así es imposible
   guardar un cobro descuadrado, que era el error fácil de
   cometer y difícil de detectar después.
   ========================================================= */

export function repartir(medio, tarifa, montoEfectivo) {

    const total = Number(tarifa) || 0;

    if (medio === "Efectivo") return { montoEfectivo: total, montoQR: 0 };
    if (medio === "QR") return { montoEfectivo: 0, montoQR: total };

    // Ambos: el efectivo es lo que se digita, el QR es el resto.
    const efectivo = Math.max(0, Math.min(total, Number(montoEfectivo) || 0));
    return { montoEfectivo: efectivo, montoQR: total - efectivo };
}

/*
    Errores en texto plano, vacío si el cobro es válido. Vive
    aquí y no en el panel para que el día que se cobre desde otra
    pantalla no haya dos versiones de las mismas reglas.

    Recibe el desglose de la tarifa (config.desglosarTarifa) y no
    un número, porque cuánto se cobra depende del soporte.
*/
export function validarCobro(datos, desglose) {

    const errores = [];

    if (!esSoporteValido(datos.soporte)) {
        errores.push("Selecciona el soporte de pago.");
        return errores;
    }

    const total = tarifaDeSoporte(desglose, datos.soporte);

    if (!(total > 0)) {
        errores.push("Esta tipología no tiene tarifa configurada. Pídele al administrador que la cargue.");
        return errores;
    }

    // Facturado al cliente: no hubo plata en portería, así que no hay
    // medio de pago que elegir ni monto que repartir. El vehículo
    // igual queda resuelto y puede salir — lo que bloquea la salida es
    // que nadie haya definido cómo se cobra, no que no haya entrado
    // efectivo.
    if (!soporteEntraACaja(datos.soporte)) return errores;

    if (!esMedioValido(datos.medio)) {
        errores.push("Selecciona el medio de pago.");
        return errores;
    }

    if (datos.medio === "Ambos") {
        const efectivo = Number(datos.montoEfectivo);

        if (!isFinite(efectivo) || efectivo < 0) {
            errores.push("El monto en efectivo no es válido.");
        } else if (efectivo <= 0) {
            errores.push("Si el pago fue solo por QR, elige QR en vez de Ambos.");
        } else if (efectivo >= total) {
            errores.push("Si el pago fue todo en efectivo, elige Efectivo en vez de Ambos.");
        }
    }

    return errores;
}


/* =========================================================
   REGISTRAR (o corregir) EL COBRO

   Escribe dos cosas: el cobro completo en su colección
   restringida, y el booleano `pagoRegistrado` en el vehículo,
   que es lo que destraba la salida en portería.

   No van en una transacción atómica a propósito. Si la segunda
   escritura fallara, el cobro queda guardado y el vehículo sigue
   bloqueado: el supervisor lo ve todavía en su lista de
   pendientes y vuelve a registrarlo, que es idempotente. Al
   revés —vehículo destrabado sin cobro guardado— sí sería un
   problema, y ese orden no puede ocurrir.
   ========================================================= */

export async function registrarCobro(operacion, vehiculo, datos, supervisor) {

    const desglose = datos.desglose || {};
    const soporte = esSoporteValido(datos.soporte) ? datos.soporte : SOPORTE_POR_DEFECTO;

    const tarifa = tarifaDeSoporte(desglose, soporte);
    const entraACaja = soporteEntraACaja(soporte);

    // Lo facturado al cliente no entra a la caja: sus montos van en
    // cero y el valor queda solo en `tarifa`, para poder sumar aparte
    // lo facturable sin mezclarlo con lo recaudado en portería.
    const montos = entraACaja
        ? repartir(datos.medio, tarifa, datos.montoEfectivo)
        : { montoEfectivo: 0, montoQR: 0 };

    const yaExistia = !!datos.esCorreccion;

    const rec = {
        operacion: operacion,
        vehiculoId: vehiculo.id,
        placa: vehiculo.placa || "",

        // Copias congeladas: la tipología se puede renombrar o
        // borrar, y su tarifa cambiar. Lo cobrado no se mueve.
        tipologia: vehiculo.tipologia || "",
        tipologiaNombre: vehiculo.tipologiaNombre || "",

        // `tarifa` es lo que efectivamente se cobró — la columna
        // "Tarifa Cobrada" del reporte. El desglose que la produjo se
        // guarda al lado, también congelado, porque la tabla de
        // tarifas cambia de un año al otro y el arqueo de este turno
        // tiene que poder rehacerse con los números de hoy.
        tarifa: tarifa,
        soporte: soporte,
        tarifaBase: Number(desglose.base) || 0,
        ivaPorcentaje: Number(desglose.ivaPorcentaje) || 0,
        iva: ivaCobradoDe(desglose, soporte),
        tarifaConIva: Number(desglose.conIva) || 0,
        tasaInlo: Number(desglose.tasaInlo) || 0,
        totalCuadrilla: Number(desglose.cuadrilla) || 0,

        // Se conserva por compatibilidad con los cobros ya guardados
        // y con quien todavía lea este campo: sigue significando
        // "no entró plata a portería".
        porFactura: !entraACaja,
        medio: entraACaja ? datos.medio : "Factura",
        montoEfectivo: montos.montoEfectivo,
        montoQR: montos.montoQR,

        // El día operativo se guarda al cobrar y no se recalcula
        // después: es el día al que pertenece la caja.
        fecha: nowLocal(),

        registradoPor: supervisor || "",
        registradoEn: serverTimestamp()
    };

    if (yaExistia) {
        rec.editadoPor = supervisor || "";
        rec.editadoEn = serverTimestamp();
    }

    await setDoc(doc(db, COLECCION, vehiculo.id), rec);

    // Sin monto ni desglose: este historial lo lee el operario, que no
    // debe ver cuánto pagó el vehículo. El soporte sí va, porque es lo
    // que el conductor lleva en la mano y puede reclamar en portería.
    const comoSeCobra = entraACaja
        ? datos.medio + ", con " + soporte.toLowerCase()
        : "se factura al cliente";

    const entrada = {
        fecha: nowLocal(),
        tipo: "pago",
        operador: supervisor || "",
        texto: (yaExistia ? "Cobro corregido — " : "Cobro registrado — ") + comoSeCobra
    };

    await updateDoc(doc(db, COLECCION_VEHICULOS, vehiculo.id), {
        pagoRegistrado: true,
        historial: arrayUnion(entrada)
    });
}


/* =========================================================
   LECTURA

   Ambas fallan con permission-denied para el operario y el
   cliente, y así debe ser: quien las llama es un panel de
   supervisor o de administrador.
   ========================================================= */

export async function obtenerCobro(vehiculoId) {
    const snap = await getDoc(doc(db, COLECCION, vehiculoId));
    return snap.exists() ? Object.assign({ id: snap.id }, snap.data()) : null;
}

/*
    Todos los cobros de una bodega, en vivo. Devuelve un mapa
    { vehiculoId: cobro } porque así lo consume el panel: para
    cada vehículo de la lista hay que saber si ya se cobró, y
    recorrer un array por cada fila sería cuadrático.
*/
export function suscribirseACobros(operacion, callback) {

    const q = query(
        collection(db, COLECCION),
        where("operacion", "==", operacion)
    );

    return onSnapshot(q, function (snapshot) {
        const porVehiculo = {};
        snapshot.forEach(function (docSnap) {
            porVehiculo[docSnap.id] = Object.assign({ id: docSnap.id }, docSnap.data());
        });
        callback(porVehiculo);
    }, function (error) {
        console.error("Error al escuchar los cobros:", error);
        callback(null, error);
    });
}


/* =========================================================
   ¿QUÉ VEHÍCULOS FALTAN POR COBRAR?

   La lista que el supervisor necesita ver de una: vehículos
   adentro, con tipología asignada, todavía sin cobro. Se ordena
   por antigüedad porque un vehículo que ya terminó su operación
   y lleva horas esperando el registro del pago está frenando un
   muelle.

   Los que no tienen tipología NO entran: su bloqueo se resuelve
   asignándosela, no cobrando, y mezclarlos aquí haría que el
   supervisor buscara un cobro que todavía no puede hacer.
   ========================================================= */

export function pendientesDeCobro(registros, cobros) {
    return (registros || [])
        .filter(function (r) {
            return !r.horaSalida && r.tipologia && !(cobros && cobros[r.id]);
        })
        .sort(function (a, b) {
            return new Date(a.horaEntrada || 0) - new Date(b.horaEntrada || 0);
        });
}

/*
    Vehículos adentro a los que todavía no se les puede cobrar
    porque nadie les asignó tipología. Se cuentan aparte para que
    el panel pueda decir por qué la lista de pendientes no cuadra
    con el total de vehículos en planta.
*/
export function sinTipologia(registros) {
    return (registros || []).filter(function (r) {
        return !r.horaSalida && !r.tipologia;
    });
}


/* =========================================================
   TOTALES DE CAJA

   Un vehículo que pagó mezclado cuenta como UNA transacción en
   su propia casilla ("Ambos"), y sus dos montos suman a los
   totales de efectivo y de QR. Así el desglose por medio nunca
   se contradice con el número de vehículos cobrados.
   ========================================================= */

/*
    El soporte de un cobro guardado. Los registrados antes de que
    el soporte existiera no lo traen: se deducen del único dato
    que había entonces, y así el histórico sigue sumando.
*/
export function soporteDe(cobro) {
    if (cobro && esSoporteValido(cobro.soporte)) return cobro.soporte;
    return cobro && cobro.porFactura ? "Facturado al cliente" : SOPORTE_POR_DEFECTO;
}

export function resumenCaja(cobros) {

    const lista = Array.isArray(cobros) ? cobros : Object.keys(cobros || {}).map(function (k) { return cobros[k]; });

    const resumen = {
        vehiculos: lista.length,

        // `total` es lo que ENTRÓ a la caja. Lo facturado se cuenta
        // aparte en `totalFacturado`: sumarlos daría una cifra que no
        // cuadra con el arqueo, porque esa plata no pasó por portería.
        total: 0,
        totalEfectivo: 0,
        totalQR: 0,
        totalFacturado: 0,
        facturados: 0,

        // El IVA que se liquidó de verdad: solo lo cobrado con
        // factura. Es la cifra que se declara, no el IVA teórico de
        // la tabla de tarifas.
        totalIva: 0,

        // Reparto del valor antes de IVA. Se suman TODOS los cobros,
        // incluidos los facturados al cliente: la cuadrilla descargó
        // el vehículo igual, y a INLOTRANS le corresponde su tasa
        // aunque la plata entre después por otro lado.
        totalCuadrilla: 0,
        gananciaInlo: 0,

        porMedio: {
            Efectivo: { n: 0, monto: 0 },
            QR: { n: 0, monto: 0 },
            Ambos: { n: 0, monto: 0 },
            Factura: { n: 0, monto: 0 }
        },

        porSoporte: {
            "Recibo Caja Menor": { n: 0, monto: 0 },
            "Factura": { n: 0, monto: 0 },
            "Facturado al cliente": { n: 0, monto: 0 }
        }
    };

    lista.forEach(function (c) {

        resumen.totalCuadrilla += Number(c.totalCuadrilla) || 0;
        resumen.gananciaInlo += Number(c.tasaInlo) || 0;

        const soporte = soporteDe(c);

        if (!soporteEntraACaja(soporte)) {
            const facturado = Number(c.tarifa) || 0;
            resumen.totalFacturado += facturado;
            resumen.facturados += 1;
            resumen.porMedio.Factura.n += 1;
            resumen.porMedio.Factura.monto += facturado;
            resumen.porSoporte[soporte].n += 1;
            resumen.porSoporte[soporte].monto += facturado;
            return;
        }

        const efectivo = Number(c.montoEfectivo) || 0;
        const qr = Number(c.montoQR) || 0;
        const total = efectivo + qr;

        resumen.total += total;
        resumen.totalEfectivo += efectivo;
        resumen.totalQR += qr;
        resumen.totalIva += Number(c.iva) || 0;

        const medio = esMedioValido(c.medio) ? c.medio : "Efectivo";
        resumen.porMedio[medio].n += 1;
        resumen.porMedio[medio].monto += total;

        resumen.porSoporte[soporte].n += 1;
        resumen.porSoporte[soporte].monto += total;
    });

    return resumen;
}
