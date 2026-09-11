/* =========================================================
   INLOTRANS
   Servicio de vehículos (Firestore)

   Migrado de la lógica _fbSave/_fbDelete de Realtime Database
   en bodega-J4.html. Mismo modelo de datos, mismo comportamiento,
   pero:
     - Ahora es Firestore, no Realtime Database.
     - Una sola colección "vehiculos" compartida por todas las
       operaciones (campo `operacion`: "J3" | "J4" | "B9"), en
       vez de árboles separados porteria/ y porteria_j4/ — así
       el panel de administrador (Fase 5) puede comparar
       operaciones sin duplicar lógica.
     - Ya no hay modo local con localStorage como respaldo
       silencioso: si Firestore falla, se avisa con un error
       real (punto 22 del prompt maestro: "no perder datos
       silenciosamente" — el modo offline real con IndexedDB
       se aborda aparte, más adelante).
   ========================================================= */

import {
    collection,
    doc,
    addDoc,
    updateDoc,
    deleteDoc,
    query,
    where,
    onSnapshot,
    arrayUnion,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { db } from "../core/firebase.js";
import { getDestino, getHistorial, ordenarPorPrioridad } from "../services/eventos.js";
import { distingueModalidad, hayTipologias } from "./config.js";
import { nowLocal } from "../utils/tiempos.js";

const COLECCION = "vehiculos";


/* =========================================================
   FASES DE UN VEHÍCULO

   Un vehículo "Ambos" hace dos fases en orden fijo: primero
   descarga y después carga. Los de un solo tipo hacen una sola.
   Se usa para saber cuántos juegos de picking/auditoría lleva
   el registro — uno por fase, porque no se puede alistar ni
   auditar lo que se va a cargar antes de haber descargado.
   ========================================================= */

export function fasesDe(tipo) {
    if (tipo === "Ambos") return ["Descargue", "Cargue"];
    return tipo ? [tipo] : [];
}


/* =========================================================
   CREAR REGISTRO (entrada de vehículo)

   `datos` trae los mismos campos que ya arma registrarEntrada()
   en bodega-J4.html (conductor, placa, hora, ubicacion,
   numeroMuelle, bahia, canal, tipo, programado, etc.)
   ========================================================= */

export async function crearRegistro(operacion, datos, operador) {

    const destinoCompleto = datos.destino;

    // Picking y auditoría se llevan POR FASE, no por vehículo: un
    // vehículo "Ambos" alista y audita lo que descarga, y después
    // alista y audita lo que carga. Se inicializan en 0 solo las
    // fases que el vehículo realmente va a hacer.
    const etapas = {};
    fasesDe(datos.tipo).forEach(function (fase) {
        etapas["picking" + fase] = 0;
        etapas["auditoria" + fase] = 0;
    });

    const rec = Object.assign(etapas, {
        operacion: operacion,

        conductor: datos.conductor || "",
        placa: datos.placa,

        horaEntrada: datos.horaEntrada,
        programado: datos.programado === "Programado",
        horaProgramacion: datos.horaProgramacion || "",

        ubicacion: datos.ubicacion,
        numeroMuelle: datos.numeroMuelle || "",
        bahia: datos.bahia || "A",
        canal: datos.canal,

        destino: destinoCompleto,

        tipo: datos.tipo,

        // Tipo de vehículo (id de la lista que el administrador
        // configura por bodega en config/{operacion}). De él salen
        // la tarifa y las metas de tiempo en muelle.
        //
        // Se guarda el ID y no el nombre porque el nombre se puede
        // corregir después ("Tracto mula" → "Tractomula") y los
        // registros viejos no deben quedar apuntando a una tipología
        // que ya no existe. `tipologiaNombre` va al lado como copia
        // congelada, para que un registro exportado a Excel siga
        // siendo legible aunque la tipología se borre.
        //
        // Puede venir vacío: mientras el administrador no haya
        // configurado ninguna tipología, el vehículo entra sin ella.
        // Lo que no puede es SALIR sin ella (ver puedeRegistrarSalida).
        tipologia: datos.tipologia || "",
        tipologiaNombre: datos.tipologiaNombre || "",

        // Avance de cargue/descargue: si el tipo ya es uno solo, el
        // "avanceTipo" queda fijo desde la entrada. Si es "Ambos", el
        // vehículo siempre arranca en Descargue — es un orden fijo del
        // negocio, no algo que el supervisor deba elegir — y al llegar
        // al 100% pasa automáticamente a Cargue (ver incrementarAvance()
        // en supervisor.js).
        avanceTipo: datos.tipo === "Ambos" ? "Descargue" : datos.tipo,
        avancePorcentaje: 0,

        cedula: datos.cedula || "",
        obs: datos.obs || "",

        // Cómo viene la mercancía: arrumada o paletizada. Solo lo
        // usan las bodegas que lo distinguen (hoy J3), y lo marca el
        // supervisor desde el muelle, no la portería. Vacío al
        // entrar significa el estándar (arrumado) — ver MODALIDADES
        // en config.js.
        modalidad: datos.modalidad || "",

        servicioTipo: datos.servicioTipo || "Normal",
        servicioEmpresa: datos.servicioEmpresa || "",

        horaSalida: null,
        obsSalida: "",

        fecha: datos.horaEntrada.slice(0, 10),

        operadorEntrada: operador,
        operadorSalida: null,

        historial: [{
            fecha: datos.horaEntrada,
            tipo: "entrada",
            operador: operador,
            ubicacion: destinoCompleto,
            texto: datos.obs || ""
        }],

        creadoEn: serverTimestamp()
    });

    const ref = await addDoc(collection(db, COLECCION), rec);

    return ref.id;
}


/* =========================================================
   SUSCRIBIRSE A REGISTROS DE UNA OPERACIÓN (tiempo real)

   Reemplaza el onValue() de Realtime Database. Devuelve una
   función `unsubscribe` — llámala cuando la página se
   desmonte/cambie de vista para no dejar listeners activos.
   ========================================================= */

export function suscribirseARegistros(operacion, callback) {

    const q = query(
        collection(db, COLECCION),
        where("operacion", "==", operacion)
    );

    return onSnapshot(q, function (snapshot) {

        const registros = [];

        snapshot.forEach(function (docSnap) {
            registros.push(Object.assign({ id: docSnap.id }, docSnap.data()));
        });

        registros.sort(function (a, b) {
            return new Date(b.horaEntrada) - new Date(a.horaEntrada);
        });

        callback(registros);

    }, function (error) {
        console.error("Error al escuchar registros:", error);
        callback(null, error);
    });
}


/* =========================================================
   ACTUALIZAR UBICACIÓN (Patio → Muelle, sin crear registro nuevo)
   ========================================================= */

export async function actualizarUbicacion(id, cambios, operador) {

    const entrada = {
        fecha: nowLocal(),
        tipo: "ubicacion",
        operador: operador,
        ubicacion: cambios.destino,
        ubicacionAnterior: cambios.ubicacionAnterior || "",
        texto: cambios.obsUbicacion || ""
    };

    const cambiosDoc = {
        ubicacion: cambios.ubicacion,
        numeroMuelle: cambios.numeroMuelle || "",
        bahia: cambios.bahia || "A",
        destino: cambios.destino,
        obsUbicacion: cambios.obsUbicacion || "",
        historial: arrayUnion(entrada)
    };

    if (cambios.canal) {
        cambiosDoc.canal = cambios.canal;
    }

    await updateDoc(doc(db, COLECCION, id), cambiosDoc);
}


/* =========================================================
   CORREGIR LOS DATOS DEL VEHÍCULO

   Para quien puede editar el registro completo: hoy el
   administrador y el supervisor de J4 (ver la regla
   `bodegasConSupervisorEditor` en firestore.rules). No es lo
   mismo que actualizarUbicacion(): aquí se corrige lo que se
   digitó mal en la entrada —placa, proveedor, número de cita,
   tipo de operación, tipología, hora de llegada, cita—, no se
   mueve el vehículo por la planta.

   ── QUÉ QUEDA EN EL HISTORIAL ──

   Una entrada con el detalle campo por campo de lo que cambió,
   con el valor viejo y el nuevo. Corregir un registro es
   reescribir lo que pasó, y sin la huella de quién lo reescribió
   y qué había antes, el historial dejaría de servir justo para
   lo que existe. Por eso la lista de cambios la arma el
   servicio y no la pantalla: así ninguna pantalla puede
   guardar una corrección sin dejar rastro.

   `CAMPOS_EDITABLES` acota qué se deja tocar por esta vía. El
   avance, las autorizaciones, los cobros y las cancelaciones NO
   están: cada uno tiene su propio flujo, con sus validaciones y
   su propia entrada de historial.

   ── LO QUE CUELGA DE UN CAMPO CORREGIDO ──

   Corregir no es solo escribir el campo nuevo. Tres datos del
   registro son COPIAS o DERIVADOS de otros, y dejarlos con el
   valor viejo es lo que hacía que una corrección "no se viera":
   el campo cambiaba en la tabla y el resto de la aplicación
   —la ficha del vehículo, la tarjeta del muelle, la alerta de
   tiempo, la regla de salida— seguía leyendo el derivado sin
   corregir. Quien corregía veía el dato viejo por todas partes y
   terminaba dudando de si el cambio se había guardado.

       fecha        el día operativo, que sale de `horaEntrada`.

       historial    el evento de entrada lleva copiadas la hora y
                    la observación con las que se registró el
                    vehículo (ver crearRegistro).

       avanceTipo   la fase que se está midiendo, que tiene que
                    ser una de las que el vehículo hace según su
                    `tipo` — ver realinearAvance().

   Todo lo demás (placa, conductor, cédula, canal, tipología,
   modalidad, cita, servicio) vive en un solo campo y se corrige
   solo.
   ========================================================= */

const CAMPOS_EDITABLES = {
    placa: "Placa",
    conductor: "Conductor / proveedor",
    cedula: "Cédula / número de cita",
    tipo: "Tipo de operación",
    canal: "Canal",
    tipologia: "Tipología",
    tipologiaNombre: "Tipología",
    modalidad: "Cómo viene la mercancía",
    horaEntrada: "Hora de entrada",
    programado: "Programado",
    horaProgramacion: "Hora de la cita",
    servicioTipo: "Tipo de servicio",
    servicioEmpresa: "Empresa del servicio",
    obs: "Observaciones de entrada"
};

function describirCambio(campo, antes, despues) {
    const nombre = CAMPOS_EDITABLES[campo] || campo;
    const vacio = (v) => (v === null || v === undefined || v === "" ? "(vacío)" : String(v));
    return nombre + ': "' + vacio(antes) + '" → "' + vacio(despues) + '"';
}


/*
    La fase del avance después de corregir el tipo de operación.

    `avanceTipo` dice cuál de las dos fases se está midiendo, y de
    ella cuelgan la meta de tiempo en muelle, el badge de la
    tarjeta del muelle, el mínimo que exige la salida y la fila
    "Fase actual" de la ficha. Corregir un "Cargue" que en realidad
    era un "Descargue" y dejarle la fase vieja dejaba el vehículo
    diciendo las dos cosas a la vez: la tabla mostraba la operación
    nueva y la tarjeta seguía midiendo la vieja.

    Devuelve SOLO lo que hay que escribir; un objeto vacío
    significa que la fase que ya tenía sigue siendo válida.
*/
function realinearAvance(actual, tipoNuevo) {

    // Registros anteriores a la función de avance: nunca se les
    // pidió el dato y no se les inventa uno al corregir otra cosa
    // (ver requiereAvanceCompleto).
    if (!actual || !requiereAvanceCompleto(actual)) return {};

    const fase = actual.avanceTipo || "";
    const pct = actual.avancePorcentaje || 0;

    if (tipoNuevo === "Ambos") {

        // El descargue va primero, siempre. Si venía midiendo
        // cargue, ese avance no se pierde: se guarda para retomarlo
        // al terminar el descargue, igual que hace
        // agregarOperacionFaltante() cuando el muelle detecta la
        // operación que faltaba.
        if (fase === "Descargue") return {};

        const cambios = { avanceTipo: "Descargue", avancePorcentaje: 0 };
        if (fase === "Cargue" && pct > 0) cambios.avanceCarguePendiente = pct;
        return cambios;
    }

    // La fase sigue valiendo. Solo queda limpiar el cargue
    // pendiente si lo había: un vehículo de una sola operación no
    // tiene una segunda fase que retomar, y la ficha lo seguiría
    // anunciando para siempre.
    if (fase === tipoNuevo) {
        return actual.avanceCarguePendiente ? { avanceCarguePendiente: 0 } : {};
    }

    /* De "Ambos" a una sola operación: la fase que se estaba
       midiendo deja de existir para este vehículo, así que su
       porcentaje no es el de la que queda. Arranca en cero —salvo
       que hubiera un cargue pendiente, que es justamente el avance
       de la fase que sobrevive—. No se relabela: decir que un
       descargue al 80% es un cargue al 80% dejaría salir un
       vehículo que no ha cargado nada.

       Vale también para un vehículo que ya salió, y es a
       conciencia: quien corrige está afirmando que este camión
       nunca hizo la otra operación, y el avance de una fase que no
       ocurrió no se puede quedar en la ficha como si sí. Queda en
       el historial de dónde salió el cero. */
    if (actual.tipo === "Ambos") {
        return {
            avanceTipo: tipoNuevo,
            avancePorcentaje: tipoNuevo === "Cargue" ? (actual.avanceCarguePendiente || 0) : 0,
            avanceCarguePendiente: 0
        };
    }

    /* Cargue ↔ Descargue: es el mismo trabajo con el rótulo
       corregido. El porcentaje se conserva — lo que se digitó mal
       fue el nombre de la operación, no lo que el muelle hizo. */
    return { avanceTipo: tipoNuevo };
}

export async function corregirRegistro(id, actual, cambios, quien) {

    const cambiosDoc = {};
    const detalle = [];

    Object.keys(cambios).forEach(function (campo) {

        if (!Object.prototype.hasOwnProperty.call(CAMPOS_EDITABLES, campo)) return;

        const nuevo = cambios[campo];
        const viejo = actual ? actual[campo] : undefined;

        // Comparación laxa a propósito: el formulario devuelve
        // strings y el documento puede traer números o booleanos.
        // Sin esto, reabrir el modal y guardar sin tocar nada
        // registraría "cambios" que nadie hizo.
        if (String(viejo == null ? "" : viejo) === String(nuevo == null ? "" : nuevo)) return;

        cambiosDoc[campo] = nuevo;

        // `tipologiaNombre` viaja junto a `tipologia` pero es una
        // copia del mismo dato: anunciarlo dos veces en el
        // historial haría ver dos correcciones donde hubo una.
        if (campo !== "tipologiaNombre") detalle.push(describirCambio(campo, viejo, nuevo));
    });

    /* ── LA FASE DEL AVANCE ──────────────────────────────
       Cambiar el tipo de operación cambia qué fases hace el
       vehículo, y la que estaba midiendo puede haber dejado de
       existir. Ver realinearAvance().

       Se revisa también cuando el tipo NO cambia, y esa es la
       parte que repara lo ya roto: los vehículos que se
       corrigieron antes de esto quedaron con el tipo nuevo y la
       fase vieja guardados en Firestore, y el modal se abre con el
       tipo que ya tienen — así que volver a elegir el correcto no
       cuenta como cambio y no se escribiría nada. Ese es
       exactamente el caso que deja al administrador marcando
       "Descargue" una y otra vez sin que la ficha se mueva.

       VA ANTES DE LA SALIDA POR "NO HAY NADA QUE CAMBIAR": una
       fase descuadrada ES algo que cambiar, aunque el formulario
       venga idéntico. Si esta comprobación quedara después del
       return, reparar exigiría además tocar cualquier otro campo,
       que es pedirle al administrador que adivine un truco.

       "Descuadrada" es solo la fase que NO es una de las que el
       vehículo hace (fasesDe): un "Ambos" midiendo cargue está
       bien —terminó de descargar y siguió— y no se toca. */
    const tipoFinal = cambiosDoc.tipo || (actual && actual.tipo) || "";

    const faseDescuadrada = !!(actual && actual.avanceTipo) &&
        fasesDe(tipoFinal).indexOf(actual.avanceTipo) === -1;

    if (tipoFinal && (cambiosDoc.tipo || faseDescuadrada)) {

        const avance = realinearAvance(actual, tipoFinal);
        Object.assign(cambiosDoc, avance);

        /* Mover la fase mueve el porcentaje que el muelle venía
           registrando, así que queda dicho en el historial: un
           avance que baja solo, sin nadie que lo explique, es
           exactamente lo que hace desconfiar del sistema. */
        if (avance.avanceTipo) {

            const antes = (actual.avanceTipo || "sin fase") + " " + (actual.avancePorcentaje || 0) + "%";

            let despues = avance.avanceTipo + " " +
                (avance.avancePorcentaje == null ? (actual.avancePorcentaje || 0) : avance.avancePorcentaje) + "%";

            if (avance.avanceCarguePendiente) {
                despues += " (quedan " + avance.avanceCarguePendiente + "% de cargue para retomar)";
            }

            // El rótulo va literal: no es un campo de CAMPOS_EDITABLES,
            // es una consecuencia de haber corregido el tipo.
            detalle.push(describirCambio("Avance de la operación", antes, despues));
        }
    }

    if (!detalle.length && !Object.keys(cambiosDoc).length) return false;

    const anotacion = {
        fecha: nowLocal(),
        tipo: "correccion",
        operador: quien || "",
        texto: "Registro corregido — " + detalle.join(" · ")
    };

    /* ── LO QUE EL EVENTO DE ENTRADA LLEVA COPIADO ───────
       La hora y la observación con las que se registró el vehículo
       están en el documento Y dentro del evento "entrada" del
       historial (ver crearRegistro). Corregirlas en uno solo dejaba
       la ficha contando dos versiones del mismo momento: arriba la
       observación nueva, abajo en la línea de tiempo la vieja. */
    const parcheEntrada = {};

    if (cambiosDoc.horaEntrada) {

        // La fecha del día operativo cuelga de la hora de entrada: si
        // se corrige la hora y no la fecha, el vehículo queda contado
        // en un día y ordenado en otro.
        cambiosDoc.fecha = String(cambiosDoc.horaEntrada).slice(0, 10);

        parcheEntrada.fecha = cambiosDoc.horaEntrada;
    }

    if (Object.prototype.hasOwnProperty.call(cambiosDoc, "obs")) {
        parcheEntrada.texto = cambiosDoc.obs || "";
    }

    if (Object.keys(parcheEntrada).length) {

        /* ── Y EL HISTORIAL TAMBIÉN ──────────────────────────
           Los tiempos por ubicación NO se calculan restando
           entrada − salida: salen del historial, evento por evento
           (ver getLocationDurations en eventos.js). Un vehículo que
           hizo patio → muelle → patio tiene dos tramos en cada
           sitio, y eso solo se sabe leyendo los eventos.

           Por eso corregir `horaEntrada` sin mover el evento de
           entrada dejaba el registro diciendo dos cosas distintas:
           la tabla mostraba la hora nueva y las tarjetas de tiempo
           —promedio en patio, promedio en muelle, pérdida de
           operación, cumplimiento por tipología— seguían calculadas
           con la vieja. El cambio se guardaba y no se veía por
           ningún lado, que es justo lo que hacía dudar de si la
           corrección había quedado. Con la observación de entrada
           pasaba lo mismo, a la vista: la ficha mostraba el texto
           nuevo en "Observaciones" y el viejo en la línea de tiempo,
           dos renglones más abajo.

           Se reescribe el array completo en vez de usar
           arrayUnion(): no hay forma de modificar un elemento
           existente de un array de Firestore. Se acepta a
           conciencia que esto pisa lo que otro usuario haya
           agregado al historial en el mismo instante — corregir un
           registro es una acción rara, deliberada y de una sola
           persona, y la alternativa es dejar el vehículo con dos
           horas de entrada distintas para siempre.

           Solo aplica a los registros que YA traen historial
           guardado. Los antiguos que no lo tienen se corrigen
           solos: getHistorial() los reconstruye a partir de
           `horaEntrada`, así que leen la hora nueva sin que haya
           nada que reescribir. */
        if (Array.isArray(actual && actual.historial) && actual.historial.length) {

            cambiosDoc.historial = getHistorial(actual).map(function (h) {
                return h.tipo === "entrada"
                    ? Object.assign({}, h, parcheEntrada)
                    : h;
            }).concat([anotacion]);

        } else {
            cambiosDoc.historial = arrayUnion(anotacion);
        }

    } else {
        cambiosDoc.historial = arrayUnion(anotacion);
    }

    await updateDoc(doc(db, COLECCION, id), cambiosDoc);
    return true;
}


/* =========================================================
   AGREGAR UNA OBSERVACIÓN (sin mover el vehículo)

   El operario ve algo que vale la pena dejar por escrito —el
   conductor se fue a almorzar, el muelle está esperando montacargas,
   la mercancía llegó mal estibada— y no tiene por qué pasar por el
   modal de mover ubicación para anotarlo. Antes ese era el único
   camino, así que o se abría un modal que pedía ubicación y canal
   para no cambiarlos, o la observación no se escribía.

   `obsUbicacion` queda con la última observación (es el campo que
   los paneles muestran como "motivo" en la columna de patio), y el
   texto completo se apila en el historial, que es lo que nunca se
   pierde.
   ========================================================= */

export async function agregarObservacion(id, texto, operador) {

    const entrada = {
        fecha: nowLocal(),
        tipo: "observacion",
        operador: operador,
        texto: texto
    };

    await updateDoc(doc(db, COLECCION, id), {
        obsUbicacion: texto,
        historial: arrayUnion(entrada)
    });
}


/* =========================================================
   AGREGAR LA OPERACIÓN QUE LE FALTABA (Cargue o Descargue → Ambos)

   El operario detecta en muelle que un vehículo que solo iba a
   hacer una operación en realidad necesita las dos, y lo marca
   aquí como "Ambos". `rec` es el registro actual en memoria del
   llamador (para saber en qué fase de avance está y no perder
   nada al reordenar):

     - Si ya estaba en fase Descargue, no se toca — es el orden
       correcto (descargue siempre va primero) y sigue igual.
     - Si estaba en fase Cargue sin avance (0%) o no tenía fase
       todavía (vehículo de antes de esta función), se reinicia
       en Descargue — no hay nada que perder.
     - Si ya estaba en fase Cargue CON avance, ese % se guarda en
       `avanceCarguePendiente` para retomarlo automáticamente en
       cuanto termine el descargue (ver avanzarAFaseCargue en
       supervisor.js) — no se pierde el trabajo ya hecho.
   ========================================================= */

export async function agregarOperacionFaltante(id, rec, operador) {

    if (rec.tipo === "Ambos") return;

    const faltante = rec.tipo === "Cargue" ? "Descargue" : "Cargue";

    const entrada = {
        fecha: nowLocal(),
        tipo: "operacion",
        operador: operador,
        tipoAnterior: rec.tipo,
        tipoNuevo: "Ambos",
        texto: `Se agregó ${faltante} — el vehículo ya venía haciendo ${rec.tipo}`
    };

    const cambiosDoc = {
        tipo: "Ambos",
        historial: arrayUnion(entrada)
    };

    if (rec.avanceTipo !== "Descargue") {
        cambiosDoc.avanceTipo = "Descargue";
        cambiosDoc.avancePorcentaje = 0;

        if (rec.avanceTipo === "Cargue" && (rec.avancePorcentaje || 0) > 0) {
            cambiosDoc.avanceCarguePendiente = rec.avancePorcentaje;
        }
    }

    await updateDoc(doc(db, COLECCION, id), cambiosDoc);
}


/* =========================================================
   REGISTRAR SALIDA (despacho)
   ========================================================= */

export async function registrarSalida(id, horaSalida, obsSalida, operador) {

    const entrada = {
        fecha: horaSalida,
        tipo: "salida",
        operador: operador,
        texto: obsSalida || ""
    };

    await updateDoc(doc(db, COLECCION, id), {
        horaSalida: horaSalida,
        obsSalida: obsSalida || "",
        operadorSalida: operador,
        historial: arrayUnion(entrada)
    });
}


/* =========================================================
   VEHÍCULO CANCELADO

   Un vehículo cancelado es uno cuya operación no se hizo. Hay
   dos maneras de llegar ahí y las dos quedan en el mismo sitio,
   distinguidas por `cancelacion.llego`:

     llego: true   entró, estuvo en patio o muelle, y se fue sin
                   cargar ni descargar. Lo cierra cancelarVehiculo().

     llego: false  la cita se canceló y el vehículo nunca vino.
                   Lo crea crearCitaCancelada(), sin ubicación ni
                   paso por muelle.

   Se guardan juntos —y no en una colección aparte— porque son la
   misma pregunta contada de dos formas: cuánto de lo programado
   no se ejecutó. Separarlos obligaría a cruzar dos colecciones
   para responderla.

   UN CANCELADO NO ES UNA SALIDA NORMAL. Lleva `horaSalida` para
   que todo lo que ya pregunta "¿sigue adentro?" siga funcionando
   sin tocarse, pero `cancelado` en true es lo que impide que se
   cuele en los promedios de desempeño: un vehículo que no operó
   no tardó cero minutos en muelle, simplemente no estuvo.

   El motivo es obligatorio. Sin él la cifra de cancelados sería
   un número sin explicación, que es justo lo que nadie puede
   accionar.
   ========================================================= */

export function estaCancelado(r) {
    return !!(r && r.cancelado);
}

export function llegoAunqueCancelado(r) {
    return estaCancelado(r) && !!(r.cancelacion && r.cancelacion.llego);
}

/*
    Cancela un vehículo que YA ESTÁ REGISTRADO. Lo cierra con la
    hora en que se cancela: a partir de ahí deja de ocupar patio o
    muelle, que es lo que la portería necesita ver.
*/
export async function cancelarVehiculo(id, datos, supervisor) {

    const motivo = (datos && datos.motivo ? String(datos.motivo) : "").trim();
    if (!motivo) throw new Error("La cancelación necesita un motivo.");

    const fecha = (datos && datos.fecha) || nowLocal();

    const entrada = {
        fecha: fecha,
        tipo: "cancelacion",
        operador: supervisor || "",
        texto: "Operación cancelada — " + motivo
    };

    await updateDoc(doc(db, COLECCION, id), {
        cancelado: true,
        cancelacion: {
            motivo: motivo,
            fecha: fecha,
            canceladoPor: supervisor || "",
            llego: true
        },
        horaSalida: fecha,
        operadorSalida: supervisor || "",
        historial: arrayUnion(entrada)
    });
}

/*
    Registra una cita cancelada de un vehículo que NUNCA LLEGÓ.

    Nace cerrada: entrada y salida a la misma hora, sin ubicación
    ni muelle. Esa hora es la de la cita cuando se conoce, y no la
    del momento en que alguien se acuerda de registrarla, porque
    la cancelación pertenece al día que se dejó de operar — no al
    día en que se anotó.
*/
export async function crearCitaCancelada(operacion, datos, supervisor) {

    const motivo = (datos.motivo ? String(datos.motivo) : "").trim();
    if (!motivo) throw new Error("La cancelación necesita un motivo.");

    const momento = datos.horaProgramacion || datos.fecha || nowLocal();

    const rec = {
        operacion: operacion,

        conductor: datos.conductor || "",
        cedula: datos.cedula || "",
        placa: datos.placa || "",

        horaEntrada: momento,
        horaSalida: momento,
        fecha: momento.slice(0, 10),

        programado: !!datos.horaProgramacion,
        horaProgramacion: datos.horaProgramacion || "",

        // Nunca estuvo en ningún lado. `ubicacion` vacía es lo que
        // lo mantiene fuera de los tableros de patio y de muelle.
        ubicacion: "",
        numeroMuelle: "",
        bahia: "",
        destino: "",
        canal: datos.canal || "Otro",

        tipo: datos.tipo || "",
        tipologia: datos.tipologia || "",
        tipologiaNombre: datos.tipologiaNombre || "",

        servicioTipo: "Normal",
        servicioEmpresa: "",
        obs: datos.obs || "",

        cancelado: true,
        cancelacion: {
            motivo: motivo,
            fecha: nowLocal(),
            canceladoPor: supervisor || "",
            llego: false
        },

        operadorEntrada: supervisor || "",
        operadorSalida: supervisor || "",

        historial: [{
            fecha: nowLocal(),
            tipo: "cancelacion",
            operador: supervisor || "",
            texto: "Cita cancelada — el vehículo no llegó. " + motivo
        }],

        creadoEn: serverTimestamp()
    };

    const ref = await addDoc(collection(db, COLECCION), rec);
    return ref.id;
}


/* =========================================================
   ACTUALIZAR AVANCE (porcentaje de cargue/descargue)

   `cambios.avanceTipo` fija cuál de los dos está midiendo el
   supervisor (obligatorio elegirlo una vez cuando `tipo` es
   "Ambos"). El porcentaje siempre se guarda entre 0 y 100 —
   nunca puede pasarse de 100 aunque el llamador lo intente.
   ========================================================= */

export async function actualizarAvance(id, cambios, operador) {

    const porcentaje = Math.max(0, Math.min(100, Math.round(cambios.porcentaje)));

    const entrada = {
        fecha: nowLocal(),
        tipo: "avance",
        operador: operador,
        texto: `Avance de ${cambios.avanceTipo} actualizado a ${porcentaje}%`
    };

    await updateDoc(doc(db, COLECCION, id), {
        avanceTipo: cambios.avanceTipo,
        avancePorcentaje: porcentaje,
        historial: arrayUnion(entrada)
    });
}


/* =========================================================
   CÓMO VIENE LA MERCANCÍA (arrumada o paletizada)

   Solo en las bodegas cuya configuración lo distingue (hoy J3).
   Lo marca el supervisor desde la tarjeta del muelle, porque es
   quien ve el camión abierto: en la portería, con el vehículo
   todavía en la fila, no siempre se sabe.

   De este dato cuelga la meta de tiempo en muelle —la misma mula
   tarda 3h30 arrumada y 45 minutos paletizada— así que cambiarlo
   cambia la alerta del muelle en el acto. Por eso queda en el
   historial: es una decisión que mueve el indicador, no una nota.
   ========================================================= */

export async function actualizarModalidad(id, modalidad, operador) {

    const entrada = {
        fecha: nowLocal(),
        tipo: "modalidad",
        operador: operador || "",
        texto: "Mercancía marcada como " + modalidad
    };

    await updateDoc(doc(db, COLECCION, id), {
        modalidad: modalidad,
        historial: arrayUnion(entrada)
    });
}


/* =========================================================
   TIPOLOGÍA DEL VEHÍCULO

   La asigna el SUPERVISOR, no la portería. Se capturaba en el
   formulario de entrada, con el camión todavía cerrado y en la
   fila: la elección se hacía a ojo, y de la tipología cuelgan la
   tarifa que se le cobra y las metas de tiempo contra las que se
   mide toda la operación de la bodega. El supervisor la elige
   cuando ya vio el vehículo.

   Va acompañada de `tipologiaNombre` porque el nombre se copia
   dentro del registro a propósito: las tablas, la ficha y la
   exportación lo leen sin tener que cargar la configuración, y un
   vehículo que ya salió conserva el nombre que tenía la tipología
   entonces aunque el administrador la renombre después.

   Queda en el historial por lo mismo que la modalidad: es una
   decisión que mueve indicadores y dinero, no una nota.
   ========================================================= */

export async function actualizarTipologia(id, tipologia, operador) {

    // `tipologia` es el objeto de la configuración, o null para
    // dejar el vehículo sin clasificar otra vez (una asignación
    // equivocada tiene que poder deshacerse).
    const idTipologia = tipologia ? tipologia.id : "";
    const nombre = tipologia ? tipologia.nombre : "";

    const entrada = {
        fecha: nowLocal(),
        tipo: "tipologia",
        operador: operador || "",
        texto: nombre ? "Tipología asignada: " + nombre : "Tipología retirada"
    };

    await updateDoc(doc(db, COLECCION, id), {
        tipologia: idTipologia,
        tipologiaNombre: nombre,
        historial: arrayUnion(entrada)
    });
}


/* =========================================================
   AVANZAR A LA FASE DE CARGUE (cuando el descargue llega al 100%)

   Solo aplica a vehículos "Ambos": el descargue siempre va
   primero, y al completarse se pasa solo a Cargue. Normalmente
   arranca en 0%, salvo que el vehículo ya traía cargue pendiente
   de antes de agregarle el descargue (ver agregarOperacionFaltante)
   — en ese caso retoma exactamente donde se había quedado.
   ========================================================= */

export async function avanzarAFaseCargue(id, cambios, operador) {

    const entrada = {
        fecha: nowLocal(),
        tipo: "avance",
        operador: operador,
        texto: `Descargue completado — inicia Cargue en ${cambios.porcentajeInicial}%`
    };

    await updateDoc(doc(db, COLECCION, id), {
        avanceTipo: "Cargue",
        avancePorcentaje: cambios.porcentajeInicial,

        // Ya se retomó: el pendiente cumplió su función y deja de
        // existir. Sin esto la ficha seguía anunciando "40% ya hecho,
        // se retoma al terminar el descargue" para siempre, al lado
        // del cargue que ya iba en marcha con ese mismo 40%.
        avanceCarguePendiente: 0,

        historial: arrayUnion(entrada)
    });
}


/* =========================================================
   AUTORIZAR SALIDA ANTICIPADA (solo Cargue, desde MINIMO_CARGUE_ANTICIPADO)

   Un supervisor autoriza que un vehículo salga sin haber
   llegado al 100% de cargue, dejando constancia del motivo en
   el historial. `cambios.porcentaje` es el % que tenía el
   vehículo al momento de autorizar (lo trae el llamador, que ya
   tiene el registro en memoria) — se guarda como referencia,
   no se vuelve a validar aquí contra el servidor.
   ========================================================= */

export async function autorizarSalidaAnticipada(id, cambios, supervisor) {

    const entrada = {
        fecha: nowLocal(),
        tipo: "autorizacion",
        operador: supervisor,
        texto: cambios.motivo
    };

    await updateDoc(doc(db, COLECCION, id), {
        autorizacionSalida: {
            autorizadoPor: supervisor,
            motivo: cambios.motivo,
            fecha: nowLocal(),
            porcentajeAlAutorizar: cambios.porcentaje
        },
        historial: arrayUnion(entrada)
    });
}


/* =========================================================
   ELIMINAR REGISTRO
   ========================================================= */

export async function eliminarRegistro(id) {
    await deleteDoc(doc(db, COLECCION, id));
}


/* =========================================================
   MUELLES — ocupación y disponibilidad

   Funciones puras (sin Firestore, sin DOM): reciben la lista
   de registros ya cargada y calculan qué muelles están libres.
   La parte de "pintar el <select>" se queda en la página
   (operador.js), aquí solo se calcula el dato.
   ========================================================= */

/*
    `muelles` es la LISTA de números de muelle de la bodega —los de
    J4 son el 9, el 10 y el 11, no el 1, 2 y 3—. Se sigue aceptando
    un número suelto, que significa "1..N": es como llamaban estas
    funciones todos los paneles antes de que la numeración fuera
    configurable, y hay llamadas que todavía lo hacen.

    Pídele la lista a `numerosDeMuelle()` en config.js.
*/
function listaDeMuelles(muelles) {

    if (Array.isArray(muelles)) return muelles;

    const lista = [];
    for (let n = 1; n <= (Number(muelles) || 0); n++) lista.push(n);
    return lista;
}

export function getMuellesOcupacion(registrosActivosEnMuelle, muelles) {

    const ocupacion = {};

    listaDeMuelles(muelles).forEach(function (n) {
        ocupacion[n] = registrosActivosEnMuelle.find(function (r) {
            return String(r.numeroMuelle) === String(n);
        }) || null;
    });

    /* Vehículos parados en un muelle que ya no está en la
       numeración. Pasa el día que la bodega se renumera: los que
       entraron antes quedaron con el número viejo, y si el tablero
       solo mirara la lista nueva, esos camiones DESAPARECERÍAN de
       la pantalla con el vehículo todavía en el muelle. Se agregan
       al final para que sigan a la vista hasta que salgan. */
    registrosActivosEnMuelle.forEach(function (r) {
        const n = r.numeroMuelle;
        if (n === "" || n === null || n === undefined) return;
        if (!Object.prototype.hasOwnProperty.call(ocupacion, n)) ocupacion[n] = r;
    });

    return ocupacion;
}

export function getMuellesLibres(ocupacion, muelles, muelleActual) {

    const libres = [];

    // Solo los de la numeración vigente: un muelle que ya no existe
    // no se le puede asignar a nadie más, aunque siga ocupado.
    listaDeMuelles(muelles).forEach(function (n) {
        const ocupante = ocupacion[n];
        const esElActual = muelleActual != null && String(n) === String(muelleActual);

        if (!ocupante || esElActual) {
            libres.push(n);
        }
    });

    return libres;
}


/* =========================================================
   FILTROS DE VISTA (dashboard / grilla de muelles)
   ========================================================= */

export function getRegistrosEnPatio(registros) {
    const enPatio = registros.filter(function (r) {
        return !r.horaSalida && r.ubicacion !== "Muelle" && (r.destino || "").indexOf("Muelle") !== 0;
    });
    return ordenarPorPrioridad(enPatio);
}

export function getRegistrosEnMuelle(registros) {
    return registros.filter(function (r) {
        return !r.horaSalida && (r.ubicacion === "Muelle" || (r.destino || "").indexOf("Muelle") === 0);
    });
}

export function puedeDespachar(r) {
    if (!r) return false;
    return r.ubicacion === "Muelle" || (r.destino || "").indexOf("Muelle") === 0 || (r.destino || "").indexOf("Muelle") !== -1;
}


/* =========================================================
   REGLA: NO SALIR SIN COMPLETAR EL AVANCE (cargue/descargue)

   `avancePorcentaje` no existía antes de esta función — los
   vehículos que ya estaban activos en el sistema cuando se
   agregó nunca lo tendrán en su documento (undefined), así que
   quedan exceptuados de la regla automáticamente: no es justo
   bloquearlos por un dato que nunca se les pidió. Solo los
   registros creados de aquí en adelante (que sí traen el campo,
   aunque sea en 0) quedan sujetos a ella.

   Reglas de negocio (definidas por el cliente):
     - Cada fase (Cargue y Descargue) tiene su propio mínimo, y
       cada bodega los suyos: se configuran en config/{operacion}
       y se leen con umbralesSalida().
     - Por encima del mínimo pero por debajo del 100%, la salida
       exige que un supervisor la autorice explicando el motivo
       (autorizarSalidaAnticipada). Por debajo del mínimo no hay
       ninguna excepción posible.
     - Un mínimo de 100 significa "sin excepción": la franja
       autorizable desaparece sola. Así es como J3 y B9 mantienen
       el descargue al 100%, mientras J4 lo autoriza desde el 95%.
     - Un vehículo "Ambos" sin que el supervisor haya elegido
       todavía cuál de los dos está midiendo (avanceTipo null)
       se trata como Descargue: es la fase que va primero, y
       suponer la otra sería regalarle una excepción que quizá
       no le corresponde.

   LOS MÍNIMOS NO SE ESCRIBEN EN NINGÚN OTRO ARCHIVO. Todo el
   resto de la app (paneles de operario, supervisor, cliente y
   admin, textos de las alertas, herramienta de backfill) los
   obtiene de estas funciones pasándoles la configuración de su
   bodega: si vuelve a aparecer un número suelto en otro archivo,
   es un error esperando a que alguien cambie el umbral.

   Las constantes de abajo son solo el valor por defecto de una
   bodega sin configurar — no la última palabra.
   ========================================================= */

// Mínimo de cargue para que un supervisor pueda siquiera autorizar
// una salida anticipada. Subió de 75% a 95% por decisión del
// cliente: la ventana de excepción ahora es 95–99%.
export const MINIMO_CARGUE_ANTICIPADO = 95;

// Avance con el que un vehículo sale sin necesitar autorización.
export const MINIMO_SALIDA = 100;

/* =========================================================
   UMBRALES POR BODEGA

   Los dos números de arriba dejaron de ser la última palabra: son
   el valor por defecto de una bodega que no ha configurado nada.
   Cada bodega define los suyos en config/{operacion}, porque J4
   pidió bajar el descargue al 95% —allí no siempre se llega al
   100%— y eso no aplica a J3 ni a B9, donde el descargue sigue
   exigiendo el 100% sin excepción.

   La regla es una sola para las dos fases, y el número la
   parametriza:

     avance >= 100            sale, sin más
     avance >= minimo         sale SOLO con autorización motivada
                              de un supervisor
     avance <  minimo         no sale, sin excepción posible

   Cuando el mínimo es 100 la franja de excepción desaparece sola,
   que es exactamente el comportamiento que tenía el descargue
   antes de esto. Por eso no hace falta un caso especial: el
   descargue "sin excepción" es simplemente minimo = 100.

   Todas las funciones aceptan `config` como segundo argumento y
   siguen funcionando sin él — un llamador que todavía no lo pase
   obtiene el comportamiento anterior, no un error.
   ========================================================= */

export function umbralesSalida(config) {
    return {
        Cargue: config && config.minimoCargue != null ? config.minimoCargue : MINIMO_CARGUE_ANTICIPADO,
        Descargue: config && config.minimoDescargue != null ? config.minimoDescargue : MINIMO_SALIDA
    };
}

/*
    El mínimo que le aplica a ESTE vehículo, según la fase que esté
    midiendo. Un "Ambos" al que el supervisor todavía no le eligió
    fase se trata como descargue: es la fase que va primero, y
    suponer la otra sería regalarle una excepción que quizá no le
    corresponde.
*/
export function minimoDe(r, config) {
    const u = umbralesSalida(config);
    return r && r.avanceTipo === "Cargue" ? u.Cargue : u.Descargue;
}

export function requiereAvanceCompleto(r) {
    return r.avancePorcentaje !== undefined && r.avancePorcentaje !== null;
}

export function avanceCompleto(r) {
    return (r.avancePorcentaje || 0) >= MINIMO_SALIDA;
}

export function puedeAutorizarSalidaAnticipada(r, config) {
    if (!requiereAvanceCompleto(r)) return false;
    if (avanceCompleto(r)) return false;

    const minimo = minimoDe(r, config);

    // Con el mínimo en 100 no hay franja que autorizar: la única
    // forma de salir es completar el avance.
    if (minimo >= MINIMO_SALIDA) return false;

    return (r.avancePorcentaje || 0) >= minimo;
}

/* =========================================================
   LA CLASIFICACIÓN QUE EXIGE LA SALIDA

   Un vehículo no sale sin estar clasificado. Son dos datos y los
   dos los pone el SUPERVISOR, no la portería:

       tipología   qué vehículo es. De ella cuelgan la tarifa y las
                   metas de tiempo en muelle.
       modalidad   cómo vino la mercancía, arrumada o paletizada.
                   Solo donde la bodega lo distingue.

   Sin ellos el vehículo se va y se lleva consigo la posibilidad
   de medirlo: no hay meta contra la cual comparar sus tiempos, no
   hay tarifa que cobrarle, y en los indicadores aparece como una
   fila más de "sin tipología" que ya nadie puede completar porque
   el camión no está. Es la misma razón por la que el avance
   bloquea la salida — lo que no se registró antes de que se vaya,
   no se registra nunca.

   ── POR QUÉ LA TIPOLOGÍA NO BLOQUEA SIEMPRE ──

   Solo se exige donde la bodega TIENE tipologías configuradas. Si
   el administrador todavía no ha llenado esa tabla, no hay nada
   que asignar: exigirla igual dejaría a todos los vehículos de esa
   bodega encerrados, sin ninguna forma de resolverlo desde la
   aplicación. El aviso de ese caso va en el diagnóstico, que lo
   dice en voz alta en vez de dejar salir en silencio.

   Sin `config` no se exige ninguna de las dos: un llamador que no
   la pasa no puede saber si esta bodega distingue modalidad ni si
   tiene tipologías, y bloquear por un dato que no se tiene sería
   inventar una regla.
   ========================================================= */

export function faltaClasificacion(r, config) {

    if (!r || !config) return null;

    if (hayTipologias(config) && !r.tipologia) return "tipologia";

    // La modalidad solo existe donde se distingue. Donde no, un
    // vehículo sin ella no está incompleto: está bien.
    if (distingueModalidad(config) && !r.modalidad) return "modalidad";

    return null;
}

/* =========================================================
   EL COBRO QUE EXIGE LA SALIDA

   En las bodegas que le cobran al vehículo (config.cobraVehiculos,
   hoy J4) ningún vehículo sale sin que el cobro esté registrado.
   Hasta aquí `pagoRegistrado` se escribía al cobrar pero nadie lo
   leía para autorizar la salida, así que el vehículo se iba, y el
   cobro quedaba para después — y "después" era el administrador,
   el único que podía cobrar un vehículo que ya no estaba: el
   supervisor solo ve pendientes los que siguen adentro.

   Es la misma lógica que la tipología y el avance: lo que no se
   registró antes de que se vaya, no se registra nunca. La
   diferencia es que aquí lo que se pierde es plata.

   Lo que se mira es `pagoRegistrado` en el propio vehículo y no la
   colección de cobros, a propósito: es el único dato del pago que
   la portería puede leer (ver el encabezado de cobros.js), y es
   quien registra la salida.

   Un cancelado no operó y no se cobra: no aplica. Y sin `config` no
   se exige, por lo mismo que las otras dos reglas — bloquear por un
   dato que no se tiene sería inventar una regla.
   ========================================================= */

export function faltaPago(r, config) {
    if (!r || !config || !config.cobraVehiculos) return false;
    if (estaCancelado(r)) return false;
    return !r.pagoRegistrado;
}

export function puedeRegistrarSalida(r, config) {

    // Antes que el avance: sin clasificar no sale, aunque esté al
    // 100%. Un vehículo completo pero sin tipología es exactamente
    // el que se escapa sin poder medirse ni cobrarse.
    if (faltaClasificacion(r, config)) return false;

    // Y sin cobro tampoco, donde la bodega cobra. Va aquí y no al
    // final para que las dos funciones —esta y el diagnóstico—
    // no puedan responder distinto.
    if (faltaPago(r, config)) return false;

    if (!requiereAvanceCompleto(r)) return true;
    if (avanceCompleto(r)) return true;

    const minimo = minimoDe(r, config);
    if (minimo >= MINIMO_SALIDA) return false;
    if ((r.avancePorcentaje || 0) < minimo) return false;

    return !!(r.autorizacionSalida && r.autorizacionSalida.motivo);
}

/* =========================================================
   DIAGNÓSTICO DE SALIDA (por qué NO puede salir, y qué falta)

   Las funciones de arriba responden sí/no. Esta responde
   "por qué" y, sobre todo, "cuánto falta" — que es lo que el
   operario necesita ver en portería para saber si espera o
   llama al supervisor, sin poder tocar el avance él mismo.

   Devuelve siempre el mismo objeto, así que quien lo pinta no
   tiene que repetir la lógica de negocio:

     puedeSalir  boolean  — equivalente a puedeRegistrarSalida()
     nivel       'ok' | 'sin-avance' | 'bloqueo' | 'espera'
     titulo      resumen corto (una línea, para badges/estados)
     detalle     frase completa para la alerta del modal
     accion      qué hay que hacer para desbloquearlo
     porcentaje  avance actual
     minimo      % mínimo que exige la regla que está fallando
     faltante    puntos que faltan para ese mínimo (0 si ninguno)

   `minimo`/`faltante` van en null cuando el bloqueo no se
   resuelve subiendo el porcentaje (p. ej. ya pasó el mínimo de
   cargue y lo único que falta es la firma del supervisor).

   ── EL ORDEN DE LOS BLOQUEOS ──

   Primero la clasificación, después la operación (el avance) y de
   último el cobro. Es el orden en que se resuelven: sin tipología
   no hay tarifa que cobrar, y el cobro se registra cuando la
   operación termina. Así el operario ve en cada momento lo que
   toca hacer AHORA, y no "falta el cobro" sobre un vehículo que
   todavía está descargando.
   ========================================================= */

export function diagnosticoSalida(r, config) {

    const d = diagnosticoOperacion(r, config);

    // La operación está en regla y aun así no sale: falta cobrar.
    // Se pregunta sobre lo que la operación dejó pasar, para que
    // un bloqueo de avance siga diciendo lo del avance.
    if (d.puedeSalir && faltaPago(r, config)) {
        return {
            puedeSalir: false, nivel: 'bloqueo',
            titulo: 'Falta registrar el cobro',
            detalle: 'La operación de este vehículo está en regla, pero el cobro no se ha registrado. ' +
                     'En esta bodega ningún vehículo sale sin cobrar: una vez afuera ya no hay a quién cobrarle.',
            accion: 'Pídele al supervisor que registre el cobro desde su panel — en Cobros o desde la ficha del vehículo.',
            porcentaje: d.porcentaje, minimo: null, faltante: null
        };
    }

    return d;
}

/* Lo que la salida exige de la operación en sí: clasificación y
   avance. Sin el cobro, que se pregunta aparte arriba. */
function diagnosticoOperacion(r, config) {

    if (!r) {
        return {
            puedeSalir: false, nivel: 'bloqueo',
            titulo: 'Registro no encontrado',
            detalle: 'No se encontró el registro del vehículo.',
            accion: 'Recarga la página e inténtalo de nuevo.',
            porcentaje: 0, minimo: null, faltante: null
        };
    }

    var pct = r.avancePorcentaje || 0;
    var esCargue = r.avanceTipo === 'Cargue';
    var tipo = r.avanceTipo || r.tipo || 'la operación';

    /* La clasificación va primero: un vehículo al 100% pero sin
       tipología es justamente el que se va sin poder medirse ni
       cobrarse. Los dos datos los pone el supervisor, así que el
       mensaje dice a quién hay que pedírselos — el operario no
       puede resolverlo solo y decirle "falta la tipología" sin más
       lo deja mirando un formulario que ya no la tiene. */
    var falta = faltaClasificacion(r, config);

    if (falta === 'tipologia') {
        return {
            puedeSalir: false, nivel: 'bloqueo',
            titulo: 'Falta la tipología del vehículo',
            detalle: 'Este vehículo no tiene tipología asignada. Sin ella no hay meta de tiempo contra la cual medir su operación ni tarifa que cobrarle, y una vez que salga ya no se le puede asignar.',
            accion: 'Pídele al supervisor que le asigne la tipología desde su panel.',
            porcentaje: pct, minimo: null, faltante: null
        };
    }

    if (falta === 'modalidad') {
        return {
            puedeSalir: false, nivel: 'bloqueo',
            titulo: 'Falta indicar cómo vino la mercancía',
            detalle: 'En esta bodega hay que indicar si la mercancía vino arrumada o paletizada: la misma tipología tarda tiempos muy distintos según el caso, y sin ese dato el tiempo en muelle se mide contra una meta que puede no ser la suya.',
            accion: 'Pídele al supervisor que marque la mercancía como arrumada o paletizada.',
            porcentaje: pct, minimo: null, faltante: null
        };
    }

    /* La bodega sin tipologías configuradas. Aquí no se bloquea
       —no hay ninguna que asignar, encerrar los vehículos no
       arreglaría nada— pero tampoco se deja pasar en silencio: el
       vehículo se va sin poder medirse, y eso hay que decirlo
       mientras todavía se puede hacer algo al respecto. Ver
       faltaClasificacion(). */
    var sinTabla = config && !hayTipologias(config) && !r.tipologia
        ? ' Ojo: esta bodega todavía no tiene tipologías configuradas, así que este vehículo va a salir sin clasificar y quedará fuera de los indicadores de cumplimiento. El administrador debe cargarlas.'
        : '';

    // Registros anteriores a la función de avance: nunca se les
    // pidió el dato, así que no se les puede exigir.
    if (!requiereAvanceCompleto(r)) {
        return {
            puedeSalir: true, nivel: 'sin-avance',
            titulo: 'Sin avance registrado',
            detalle: 'Este vehículo no tiene avance de cargue/descargue registrado (es un registro anterior a esta función), así que puede salir sin restricción de porcentaje.' + sinTabla,
            accion: 'Verifica manualmente con el muelle antes de confirmar la salida.',
            porcentaje: 0, minimo: null, faltante: null
        };
    }

    if (avanceCompleto(r)) {
        return {
            puedeSalir: true, nivel: sinTabla ? 'sin-avance' : 'ok',
            titulo: sinTabla ? 'Completo, pero sin clasificar' : 'Completo — listo para salir',
            detalle: 'El ' + tipo.toLowerCase() + ' está al 100%. El vehículo puede salir.' + sinTabla,
            accion: '',
            porcentaje: pct, minimo: MINIMO_SALIDA, faltante: 0
        };
    }

    var autorizada = !!(r.autorizacionSalida && r.autorizacionSalida.motivo);

    // El mínimo sale de la configuración de la bodega: J4 permite
    // autorizar el descargue desde el 95%, J3 y B9 exigen el 100%.
    var minimo = minimoDe(r, config);
    var etiqueta = esCargue ? 'cargue' : 'descargue';

    if (pct >= minimo && autorizada) {
        return {
            puedeSalir: true, nivel: 'ok',
            titulo: 'Salida anticipada autorizada',
            detalle: 'El ' + etiqueta + ' está en ' + pct + '%, pero un supervisor autorizó la salida anticipada' +
                     (r.autorizacionSalida.autorizadoPor ? ' (' + r.autorizacionSalida.autorizadoPor + ')' : '') + '.',
            accion: '',
            porcentaje: pct, minimo: minimo, faltante: 0
        };
    }

    // Mínimo en 100: no hay excepción posible en esta fase.
    if (minimo >= MINIMO_SALIDA) {
        return {
            puedeSalir: false, nivel: 'bloqueo',
            titulo: 'El ' + etiqueta + ' debe llegar al 100%',
            detalle: 'El ' + etiqueta + ' está en ' + pct + '% y debe llegar al ' + MINIMO_SALIDA + '% para poder salir. No hay excepción posible: ni el operario ni el supervisor pueden saltarse esta regla.',
            accion: 'Faltan ' + (MINIMO_SALIDA - pct) + ' puntos de ' + etiqueta + '. Espera a que el muelle lo complete.',
            porcentaje: pct, minimo: MINIMO_SALIDA, faltante: MINIMO_SALIDA - pct
        };
    }

    // Por debajo del mínimo: ni siquiera es autorizable.
    if (pct < minimo) {
        return {
            puedeSalir: false, nivel: 'bloqueo',
            titulo: 'El ' + etiqueta + ' no llega al mínimo autorizable',
            detalle: 'El ' + etiqueta + ' está en ' + pct + '% y debe llegar mínimo al ' + minimo + '% para que un supervisor siquiera pueda autorizar una salida anticipada.',
            accion: 'Faltan ' + (minimo - pct) + ' puntos para el mínimo del ' + minimo + '%, o ' + (MINIMO_SALIDA - pct) + ' para completar el ' + etiqueta + ' y salir sin autorización.',
            porcentaje: pct, minimo: minimo, faltante: minimo - pct
        };
    }

    // Entre el mínimo y el 99%: solo falta la firma del supervisor.
    return {
        puedeSalir: false, nivel: 'espera',
        titulo: 'Falta la autorización del supervisor',
        detalle: 'El ' + etiqueta + ' está en ' + pct + '% (ya pasó el mínimo del ' + minimo + '%), pero por debajo del 100% un supervisor debe autorizar la salida anticipada indicando el motivo.',
        accion: 'Pídele al supervisor que autorice la salida, o espera los ' + (MINIMO_SALIDA - pct) + ' puntos que faltan para el 100%.',
        porcentaje: pct, minimo: null, faltante: null
    };
}
