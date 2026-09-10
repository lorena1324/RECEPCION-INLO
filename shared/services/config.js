/* =========================================================
   INLOTRANS
   Configuración por bodega (Firestore)

   Hasta ahora los números que gobiernan la operación estaban
   fijos en el código: 120 minutos de meta en patio en
   estadisticas.js, 120/240 para las alertas de prioridad en
   eventos.js, y el número de muelles repetido en cada panel.
   Cambiar cualquiera exigía tocar un archivo y volver a
   desplegar, y como cada bodega necesita valores distintos, el
   número terminaba siendo el de la bodega que se configuró
   primero.

   Aquí viven esos valores, uno por bodega, editables desde el
   panel de administrador. La estructura es la misma para J3, J4
   y B9, pero NINGUNA hereda de otra: las tipologías de vehículo
   de una bodega no tienen por qué existir en las demás.

   ── POR QUÉ LAS TARIFAS NO ESTÁN EN ESTE DOCUMENTO ──

   Las reglas de seguridad de Firestore autorizan documentos
   completos, no campos sueltos. El operario TIENE que leer esta
   configuración —necesita la lista de tipologías para llenar el
   formulario de entrada— así que cualquier cosa que se guarde
   aquí, la puede leer él. Esconderla en la interfaz no sirve de
   nada: se ve desde la consola del navegador.

   Por eso el dinero vive aparte, en la subcolección
   `config/{operacion}/privado/tarifas`, que las reglas abren solo
   a supervisor y administrador. Este documento lleva el nombre y
   los tiempos de cada tipología; el otro, cuánto cuesta cada una.
   Las dos mitades se unen por el id de la tipología.
   ========================================================= */

import {
    doc,
    getDoc,
    setDoc,
    onSnapshot,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { db } from "../core/firebase.js";

const COLECCION = "config";

// Subcolección restringida donde vive el dinero. El nombre del
// documento es fijo: solo hay uno por bodega.
const SUB_PRIVADO = "privado";
const DOC_TARIFAS = "tarifas";

// IVA colombiano. Es uno solo para toda la bodega y no por
// tipología: el día que cambie la tarifa del impuesto se cambia
// aquí y en el documento de la bodega, no en nueve sitios.
export const IVA_POR_DEFECTO = 19;


/* =========================================================
   FASES / TIPOS DE OPERACIÓN

   Los mismos tres valores que ya usa el campo `tipo` de un
   vehículo. Se listan aquí porque cada tipología configura sus
   tiempos para los tres.
   ========================================================= */

export const TIPOS_OPERACION = ["Cargue", "Descargue", "Ambos"];


/* =========================================================
   UMBRALES DE PATIO

   Decisión del cliente: la espera en patio es igual para todos,
   sin distinción de tipología —esperar es esperar, y un vehículo
   no merece más cola por ser más grande—. Un solo número por
   bodega hace dos trabajos, porque pasarse de la meta es
   exactamente lo que merece atención:

       limitePatio      → límite de pérdida de operación
                          Y umbral de "Atención"
       limitePatio × 2  → umbral de "Urgente"

   El multiplicador reproduce el comportamiento que el sistema ya
   tenía cuando los dos números estaban fijos (120 → 240). Vive
   aquí y en ningún otro lado.
   ========================================================= */

export const MULTIPLICADOR_URGENTE_PATIO = 2;

/* =========================================================
   NUMERACIÓN DE LOS MUELLES

   Los números REALES de los muelles de la bodega, en orden. Todo
   el que pinte el tablero o llene un desplegable de muelles los
   pide aquí en vez de contar de 1 a N: así el día que una bodega
   cambie su numeración no hay seis bucles regados por los paneles
   que corregir uno por uno.

   `cuantos` permite pasar el número que el panel ya tenga como
   valor de partida mientras Firestore responde, sin obligarlo a
   inventar una configuración a medias.
   ========================================================= */

export function numerosDeMuelle(config, cuantos) {

    const total = cuantos != null ? cuantos : ((config && config.muelles) || 0);

    // Un primer muelle en 0 o negativo no existe: sería un tablero
    // con una tarjeta que nadie puede señalar en la planta.
    const desde = Math.max(1, (config && config.primerMuelle) || 1);

    const lista = [];
    for (let i = 0; i < total; i++) lista.push(desde + i);
    return lista;
}

export function umbralesPatio(config) {
    const limite = (config && config.limitePatio) || 0;
    return {
        limite: limite,
        atencion: limite,
        urgente: limite * MULTIPLICADOR_URGENTE_PATIO
    };
}


/* =========================================================
   LOS DOS CAMPOS LIBRES DE LA ENTRADA

   En J3 y B9 la portería anota el nombre del CONDUCTOR y su
   CÉDULA. En J4 esos mismos dos espacios se usan para otra cosa:
   el nombre del PROVEEDOR y el NÚMERO DE LA CITA del vehículo.

   Son los mismos dos campos del registro (`conductor` y `cedula`)
   con otro rótulo, y no dos campos nuevos, a propósito: partir el
   modelo en dos formas de documento obligaría a cada tabla, cada
   exportación y cada indicador a preguntar de qué bodega viene el
   registro antes de saber qué mostrar. Lo que cambia es cómo se
   llama y qué se acepta, no dónde se guarda. Por eso mismo
   renombrar NO reescribe lo ya registrado: un vehículo anotado
   antes del cambio conserva el texto que se le digitó.

   `formato` gobierna lo que el campo deja escribir:

       letras  nombres de persona (no admite números)
       numero  solo dígitos
       texto   cualquier cosa — un proveedor puede ser
               "Distribuidora 3M S.A.S." y un número de cita
               puede traer letras

   Estos son los valores DE PARTIDA, no una imposición: el
   administrador puede renombrarlos por bodega desde su panel, y
   lo que él guarde manda sobre lo de aquí. Viven en el código
   para que una bodega recién creada —o una a la que todavía
   nadie le ha abierto la configuración— arranque ya rotulada
   como se opera de verdad, en vez de pedirle al operario de J4
   la "cédula" de un proveedor hasta que alguien lo note.
   ========================================================= */

const CAMPOS_GENERICOS = {
    conductor: { etiqueta: "Conductor", formato: "letras" },
    cedula: { etiqueta: "Cédula / documento", formato: "numero" }
};

/*
    En qué arranca cada bodega cuando se aparta del genérico. Un
    solo sitio para todas las diferencias de partida: buscar "qué
    tiene J4 distinto" no debería obligar a leer el archivo entero.
*/
const POR_BODEGA = {

    J3: {
        // J3 distingue si la mercancía viene arrumada (bulto a
        // bulto) o paletizada (en estibas): la misma mula tarda
        // 3h30 arrumada y 45 minutos paletizada, así que medir las
        // dos contra la misma meta no dice nada. Ver MODALIDADES.
        distingueModalidad: true
    },

    J4: {
        campos: {
            conductor: { etiqueta: "Proveedor", formato: "texto" },
            cedula: { etiqueta: "Número de cita", formato: "texto" }
        },

        // J4 es la única bodega que hoy cancela operaciones: la
        // portería registra citas que no llegaron y el supervisor
        // marca vehículos que se fueron sin cargar.
        manejaCancelaciones: true,

        // Los muelles de J4 no se numeran desde 1: dentro de la
        // planta son el 9, el 10 y el 11. Ver `primerMuelle`.
        primerMuelle: 9,

        // J4 es la bodega que le cobra al vehículo. Sin esto, el
        // menú de Cobros, la tabla de tarifas del administrador y
        // TODO lo de pago en la ficha del vehículo quedan ocultos
        // — que es exactamente lo que estaba pasando. Ver
        // `cobraVehiculos` abajo.
        cobraVehiculos: true
    }
};

function defectoDeBodega(operacion, clave, generico) {
    const propio = POR_BODEGA[operacion];
    return propio && propio[clave] !== undefined ? propio[clave] : generico;
}

/*
    Copias nuevas en cada llamada: quien recibe una configuración
    por defecto la edita (el borrador del panel de administrador,
    sin ir más lejos), y devolver siempre el mismo objeto haría
    que esa edición se le pegara a la siguiente bodega que se
    abriera.
*/
function camposPorDefecto(operacion) {
    const base = defectoDeBodega(operacion, "campos", CAMPOS_GENERICOS);
    return {
        conductor: Object.assign({}, base.conductor),
        cedula: Object.assign({}, base.cedula)
    };
}


/* =========================================================
   CONFIGURACIÓN POR DEFECTO

   Lo que devuelve el servicio cuando una bodega todavía no tiene
   documento en Firestore. Importante: `tipologias` arranca VACÍA
   a propósito. Cada bodega maneja tipos de vehículo distintos y
   sembrar una lista genérica solo lograría que alguien la diera
   por buena sin revisarla.

   `limitePatio` sí arranca en 120 porque ese es el valor con el
   que el sistema ha venido operando: dejarlo en 0 marcaría a
   todos los vehículos como fuera de meta desde el primer minuto.
   ========================================================= */

export function configPorDefecto(operacion) {
    return {
        operacion: operacion,

        /* ── Identidad de la bodega ──────────────────────────
           Estaban fijos en el código y repetidos en los diez
           paneles: el nombre del cliente y el número de muelles
           en cada operador, supervisor, cliente y admin, y la
           hora de corte en todos. Cambiar un muelle exigía tocar
           diez archivos y volver a desplegar.

           `cliente` y `muelles` arrancan vacíos y NO en un valor
           inventado: cada panel conserva el número con el que
           viene operando como valor de partida y solo lo cede
           cuando aquí hay algo configurado. Así una bodega que
           todavía no se ha tocado sigue funcionando igual.

           `horaCorte` sí arranca en 6 porque es el mismo en las
           tres bodegas desde siempre.
           ──────────────────────────────────────────────────── */
        cliente: "",
        muelles: 0,
        horaCorte: 6,

        /* ── Desde qué número se cuentan los muelles ──────────
           `muelles` dice CUÁNTOS hay; este dice cómo se llama el
           primero. Son dos cosas distintas y hasta ahora se
           confundían en una: el tablero numeraba siempre 1..N.

           J4 tiene tres muelles, pero dentro de la planta son el
           9, el 10 y el 11. Llamarlos 1, 2 y 3 en la pantalla
           obliga al operario a traducir cada vez que mira el
           tablero y camina hasta el muelle — y a equivocarse
           cuando va de afán. Ver POR_BODEGA.
           ──────────────────────────────────────────────────── */
        primerMuelle: defectoDeBodega(operacion, "primerMuelle", 1),

        /* Cómo se llaman los dos campos libres de la entrada. Ver
           CAMPOS_POR_BODEGA, más arriba. */
        campos: camposPorDefecto(operacion),

        /* Vehículos cancelados. Solo donde la operación lo maneja:
           en las demás bodegas el botón no aparece, para no ofrecer
           un estado que nadie va a usar y que ensuciaría los
           indicadores con una categoría siempre vacía. Hoy solo J4
           — ver POR_BODEGA. */
        manejaCancelaciones: defectoDeBodega(operacion, "manejaCancelaciones", false),

        /* Si esta bodega pregunta cómo viene la mercancía. Donde
           está en false no se ofrece la opción en ninguna pantalla
           y las metas se miden contra un solo número, que es como
           venían operando las tres. Ver MODALIDADES. */
        distingueModalidad: defectoDeBodega(operacion, "distingueModalidad", false),

        /* No todas las bodegas cobran. Hoy solo J4 le cobra al
           vehículo; J3 y B9 usan las mismas tipologías para medir
           tiempos, pero sin tarifa de por medio.

           Este interruptor gobierna TODO lo de dinero: el menú de
           Cobros del supervisor, los campos de tarifa del panel de
           administrador y los bloques de pago de la ficha del
           vehículo. En false, nada de eso existe.

           J4 lo trae en true desde POR_BODEGA. Estuvo en false para
           las tres —el campo es nuevo y ningún documento guardado lo
           traía— y por eso en J4 no salía ni el medio de pago ni el
           cobro en el detalle: no es que faltara el dato, es que la
           bodega figuraba como que no cobra.

           El comentario que estaba aquí advertía que marcarla en
           true bloquearía la salida de los vehículos esperando un
           pago. Eso no ocurre: `pagoRegistrado` se escribe al cobrar
           pero HOY NADIE LO LEE para autorizar la salida — ni
           puedeRegistrarSalida() ni diagnosticoSalida() lo miran. Lo
           único que exige la salida es la tipología. Si algún día se
           implementa ese bloqueo, hay que revisar esta línea antes. */
        cobraVehiculos: defectoDeBodega(operacion, "cobraVehiculos", false),

        limitePatio: 120,

        /* ── Umbrales de salida ──────────────────────────────
           Cuánto avance debe tener un vehículo para poder salir.
           100 significa "sin excepción posible". Por debajo de
           100, el tramo entre el mínimo y el 99% queda abierto a
           que un supervisor autorice la salida explicando el
           motivo; por debajo del mínimo no hay excepción.

           Vivían fijos en vehiculos.js, iguales para las tres
           bodegas. Están aquí porque J4 pidió bajar el descargue
           a 95% —no siempre se llega al 100%— y esa es una
           realidad de esa bodega, no de las otras dos: en J3 y
           B9 el descargue sigue exigiendo el 100%.
           ──────────────────────────────────────────────────── */
        minimoCargue: 95,
        minimoDescargue: 100,

        /* Capacidad instalada: cuántos vehículos alcanza a
           atender la bodega en un día. Es el denominador del
           indicador de nivel de servicio por capacidad. */
        capacidadDiaria: 0,

        posicionesTotales: 0,

        /* Hora límite del reporte diario de ocupación. Es UNA
           sola: J4 confirmó que el envío se hace una vez al día,
           así que la lista de varios cortes que había antes se
           reemplazó por este campo. */
        horaReporteOcupacion: "",

        pesosNivelServicio: { cita: 50, programacion: 50 },
        tipologias: []
    };
}

/*
    Completa un documento de Firestore con los valores por
    defecto que le falten. Un documento guardado antes de que
    existiera un campo nuevo no debe dejar la app sin ese campo:
    se rellena en la lectura, sin reescribir la base.
*/
function normalizar(operacion, datos) {

    const base = configPorDefecto(operacion);
    if (!datos) return base;

    const pesos = datos.pesosNivelServicio || base.pesosNivelServicio;

    return {
        operacion: operacion,
        cliente: datos.cliente ? String(datos.cliente) : base.cliente,
        muelles: numeroODefecto(datos.muelles, base.muelles),
        primerMuelle: numeroODefecto(datos.primerMuelle, base.primerMuelle),
        horaCorte: numeroODefecto(datos.horaCorte, base.horaCorte),
        campos: normalizarCampos(datos.campos, base.campos),
        manejaCancelaciones: booleanODefecto(datos.manejaCancelaciones, base.manejaCancelaciones),
        distingueModalidad: booleanODefecto(datos.distingueModalidad, base.distingueModalidad),
        cobraVehiculos: booleanODefecto(datos.cobraVehiculos, base.cobraVehiculos),
        limitePatio: numeroODefecto(datos.limitePatio, base.limitePatio),
        minimoCargue: numeroODefecto(datos.minimoCargue, base.minimoCargue),
        minimoDescargue: numeroODefecto(datos.minimoDescargue, base.minimoDescargue),
        capacidadDiaria: numeroODefecto(datos.capacidadDiaria, base.capacidadDiaria),
        posicionesTotales: numeroODefecto(datos.posicionesTotales, base.posicionesTotales),

        // Los documentos guardados antes de que el reporte pasara a
        // ser uno solo al día traen `cortesOcupacion` con varias
        // horas. Se toma la primera en vez de perderlas en silencio:
        // así una bodega ya configurada no aparece sin hora.
        horaReporteOcupacion: datos.horaReporteOcupacion ||
            (Array.isArray(datos.cortesOcupacion) && datos.cortesOcupacion.length
                ? datos.cortesOcupacion[0]
                : ""),
        pesosNivelServicio: {
            cita: numeroODefecto(pesos.cita, 50),
            programacion: numeroODefecto(pesos.programacion, 50)
        },
        tipologias: Array.isArray(datos.tipologias) ? datos.tipologias.map(normalizarTipologia) : [],
        actualizadoEn: datos.actualizadoEn || null,
        actualizadoPor: datos.actualizadoPor || null
    };
}

function numeroODefecto(valor, porDefecto) {
    const n = Number(valor);
    return isFinite(n) && n >= 0 ? n : porDefecto;
}

/*
    Un interruptor guardado. La distinción importa: `false` es una
    decisión que alguien tomó y se respeta, pero AUSENTE no es
    "apagado" — es un documento escrito antes de que el interruptor
    existiera, y ahí manda el valor por defecto de la bodega.

    Leerlo como `datos.campo === true` trataba las dos cosas igual,
    y por eso un interruptor nuevo nacía apagado en todas partes sin
    forma de encenderlo desde el código: el panel de administrador
    tenía que ir bodega por bodega a activar algo que ya debía venir
    activo. Es el mismo criterio que numeroODefecto().
*/
function booleanODefecto(valor, porDefecto) {
    return typeof valor === "boolean" ? valor : porDefecto;
}


/* =========================================================
   ETIQUETAS DE LOS CAMPOS LIBRES DE LA ENTRADA

   Un rótulo vacío se completa con el de siempre en vez de
   dejar el formulario con una etiqueta en blanco: un campo sin
   nombre no se puede llenar.
   ========================================================= */

export const FORMATOS_CAMPO = ["letras", "numero", "texto"];

function normalizarCampo(guardado, base) {
    const c = guardado || {};
    return {
        etiqueta: c.etiqueta ? String(c.etiqueta) : base.etiqueta,
        formato: FORMATOS_CAMPO.indexOf(c.formato) !== -1 ? c.formato : base.formato
    };
}

function normalizarCampos(guardado, base) {
    const c = guardado || {};
    return {
        conductor: normalizarCampo(c.conductor, base.conductor),
        cedula: normalizarCampo(c.cedula, base.cedula)
    };
}

/*
    El rótulo de uno de los dos campos. Se le pide a esta función
    y no se escribe suelto en cada tabla para que el día que J4
    cambie "Proveedor" por otra cosa no queden veinte sitios
    diciendo lo viejo.
*/
export function etiquetaCampo(config, campo) {
    const c = config && config.campos && config.campos[campo];
    if (c && c.etiqueta) return c.etiqueta;
    return camposPorDefecto(config && config.operacion)[campo].etiqueta;
}

export function formatoCampo(config, campo) {
    const c = config && config.campos && config.campos[campo];
    if (c && FORMATOS_CAMPO.indexOf(c.formato) !== -1) return c.formato;
    return camposPorDefecto(config && config.operacion)[campo].formato;
}

/*
    Quita del texto lo que su formato no admite. Se usa en cada
    tecla, no solo al guardar, para que el campo nunca llegue a
    mostrar algo que no va a poder registrarse.
*/
export function limpiarSegunFormato(valor, formato) {
    const v = String(valor == null ? "" : valor);
    if (formato === "letras") return v.replace(/[^A-Za-zÁÉÍÓÚÑÜáéíóúñü\s'.-]/g, "");
    if (formato === "numero") return v.replace(/[^0-9]/g, "");
    return v;
}

/* El mensaje que se le muestra al operario cuando lo escrito no
   cuadra con el formato. Devuelve "" si está bien. */
export function errorDeFormato(valor, formato, etiqueta) {
    if (!valor) return "";
    if (limpiarSegunFormato(valor, formato) === valor) return "";
    return formato === "letras"
        ? etiqueta + " solo puede tener letras."
        : etiqueta + " solo puede tener números.";
}


/* =========================================================
   TIPOLOGÍAS

   Una tipología es un tipo de vehículo de ESTA bodega, con los
   tiempos que debería tardar en muelle. Los tiempos se abren por
   tipo de operación porque una tractomula que descarga no tarda
   lo mismo que una que carga.

   Cada operación lleva UN número, la meta: cuánto debería tardar
   ese vehículo en muelle. Los dos umbrales de aviso salen de ella:

       meta          cuánto DEBERÍA tardar (mide cumplimiento)
       meta          → amarillo, desde que se pasa de la meta
       meta × 2      → rojo, desde que la dobla

   Antes los tres se digitaban por separado, y era pedir
   veintisiete números por bodega para expresar una regla que
   siempre fue la misma: pasarse de la meta merece atención y
   doblarla merece alarma. Es exactamente el criterio que ya usa
   la espera en patio (ver MULTIPLICADOR_URGENTE_PATIO), así que
   ahora las dos cosas se leen igual y no pueden contradecirse.

   Se guarda solo la meta. Los umbrales son derivados y un
   derivado guardado es un derivado que puede quedar
   descuadrado — los documentos viejos que traigan `atencion` y
   `urgente` los ignoran y se recalculan.

   La tarifa NO está aquí: ver el encabezado del archivo.
   ========================================================= */

// Al doble de la meta empieza el rojo. La franja amarilla va de la
// meta al doble; la roja, del doble en adelante.
export const MULTIPLICADOR_URGENTE_TIPOLOGIA = 2;

/*
    Los tres umbrales de una operación a partir de su meta. Es la
    única definición de la regla: quien necesite el amarillo o el
    rojo los pide aquí en vez de multiplicar por su cuenta.
*/
export function umbralesTiempo(meta) {
    const m = numeroODefecto(meta, 0);
    return {
        meta: m,
        atencion: m,
        urgente: m * MULTIPLICADOR_URGENTE_TIPOLOGIA
    };
}

/* =========================================================
   CÓMO VIENE LA MERCANCÍA

   Arrumada (bulto a bulto) o paletizada (en estibas). No es un
   detalle del papeleo: una mula que se descarga bulto a bulto
   tarda 3h30 y la misma mula paletizada tarda 45 minutos. Medir
   las dos contra la misma meta convierte el indicador en ruido.

   Solo la distinguen las bodegas cuya configuración trae
   `distingueModalidad` (hoy J3). En las demás no se pregunta y
   todo se mide contra la meta única, que es como venía operando.

   `Arrumado` es el estándar: es lo que aplica cuando nadie ha
   dicho lo contrario. Se eligió así y no al revés porque es el
   caso más lento — equivocarse hacia la meta larga da una alerta
   tarde, y hacia la corta daría alarmas falsas en todos los
   vehículos que nadie alcanzó a marcar.
   ========================================================= */

export const MODALIDADES = ["Arrumado", "Paletizado"];

export const MODALIDAD_POR_DEFECTO = "Arrumado";

export function esModalidadValida(m) {
    return MODALIDADES.indexOf(m) !== -1;
}

export function modalidadDe(rec) {
    return rec && esModalidadValida(rec.modalidad) ? rec.modalidad : MODALIDAD_POR_DEFECTO;
}

export function distingueModalidad(config) {
    return !!(config && config.distingueModalidad);
}

export function tiemposEnCero() {
    const t = {};
    TIPOS_OPERACION.forEach(function (op) {
        // `meta` es la de ARRUMADO, que es también la meta única de
        // las bodegas que no distinguen modalidad. `metaPaletizado`
        // es opcional: en cero significa "esta tipología no llega
        // paletizada" (el N/A de las tablas de tiempos), y entonces
        // se mide contra `meta`.
        t[op] = { meta: 0, metaPaletizado: 0 };
    });
    return t;
}

export function nuevaTipologia(nombre) {
    return {
        id: "tpl_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        nombre: nombre || "",
        tiempos: tiemposEnCero()
    };
}

function normalizarTipologia(t) {

    const tiempos = tiemposEnCero();

    // Solo la meta. Un documento guardado cuando los umbrales se
    // digitaban trae `atencion` y `urgente`: se descartan aquí y
    // vuelven a salir de la meta, que es de donde salen ahora.
    TIPOS_OPERACION.forEach(function (op) {
        const guardado = (t && t.tiempos && t.tiempos[op]) || {};
        tiempos[op] = {
            meta: numeroODefecto(guardado.meta, 0),
            // Los documentos guardados antes de que existiera la
            // modalidad no lo traen: quedan en cero, que significa
            // "no se distingue" y hace que todo se mida contra
            // `meta`, exactamente como venían midiendo.
            metaPaletizado: numeroODefecto(guardado.metaPaletizado, 0)
        };
    });

    return {
        id: t && t.id ? t.id : nuevaTipologia().id,
        nombre: t && t.nombre ? String(t.nombre) : "",
        tiempos: tiempos
    };
}

export function buscarTipologia(config, tipologiaId) {
    if (!config || !tipologiaId) return null;
    return (config.tipologias || []).find(function (t) { return t.id === tipologiaId; }) || null;
}

/*
    Cómo se llama HOY la tipología de un vehículo.

    El registro lleva el nombre copiado dentro (`tipologiaNombre`)
    para que las tablas y la exportación no tengan que cargar la
    configuración, y para que un vehículo cuya tipología alguien
    borró no quede sin nombre. Pero esa copia se congela el día que
    se asigna: si el administrador corrige el nombre —lo escribió
    mal, lo unificó, le cambió la nomenclatura— la corrección no
    llegaba a ninguna ficha ni a ninguna tabla. Quedaba visible
    solo en Configuración, que es el único sitio donde nadie
    necesita leerla.

    Y no es solo cosmético: las estadísticas agrupan por nombre, así
    que renombrar partía una tipología en dos filas —los vehículos
    viejos con el nombre viejo, los nuevos con el nuevo— y el
    cumplimiento de cada una se calculaba sobre la mitad de los
    datos.

    Por eso el nombre se resuelve al pintar y no se reescriben mil
    documentos: manda la configuración, y la copia congelada queda
    de respaldo para la tipología que ya no existe.
*/
export function nombreTipologiaDe(rec, config) {
    if (!rec || !rec.tipologia) return "";
    const t = buscarTipologia(config, rec.tipologia);
    return (t && t.nombre) || rec.tipologiaNombre || "";
}

export function hayTipologias(config) {
    return !!(config && (config.tipologias || []).length);
}

/*
    Los tiempos de una tipología en un tipo de operación, ya con
    los dos umbrales calculados: { meta, atencion, urgente }.

    Devuelve null —no ceros— cuando no hay tipología o no tiene
    meta: un 0 se leería como "meta de cero minutos", que marcaría
    a todos los vehículos como incumplidos.
*/
/*
    `modalidad` ('Arrumado' | 'Paletizado') solo cambia algo donde
    la tipología tiene un tiempo de paletizado configurado. Si no lo
    tiene —o si no se pasa modalidad— se mide contra `meta`, que es
    la meta única de siempre. Así las bodegas que no distinguen
    modalidad siguen funcionando sin tocar una línea.
*/
function metaDe(tiempos, modalidad) {
    if (!tiempos) return 0;
    if (modalidad === "Paletizado" && tiempos.metaPaletizado) return tiempos.metaPaletizado;
    return tiempos.meta || 0;
}

export function tiemposDe(config, tipologiaId, tipoOperacion, modalidad) {

    const t = buscarTipologia(config, tipologiaId);
    if (!t) return null;

    const directo = metaDe(t.tiempos && t.tiempos[tipoOperacion], modalidad);
    if (directo) return umbralesTiempo(directo);

    /* ── "Ambos" se mide POR FASE ──────────────────────────
       Un vehículo "Ambos" descarga y después carga, y cada fase
       tiene su propia meta. Nadie mide "el tiempo de hacer las
       dos cosas" como un número aparte, así que las tablas de
       tiempos no traen una fila para "Ambos" — la de J3 no la
       trae, y no tiene por qué.

       Cuando no hay meta propia configurada, la meta comparable
       es la SUMA de las dos fases: el tiempo que se contrasta
       contra ella es el total en muelle, y ese total cubre las
       dos. Promediarlas daría una meta que ningún vehículo
       "Ambos" podría cumplir.

       Se exigen las DOS: con una sola configurada, la suma se
       quedaría corta y marcaría como incumplidos a vehículos que
       nunca tuvieron meta completa contra la cual medirse.

       Si alguien configura una meta explícita para "Ambos", esa
       manda — se respeta arriba, antes de llegar aquí.
       ────────────────────────────────────────────────────── */
    if (tipoOperacion === "Ambos") {
        const cargue = metaDe(t.tiempos && t.tiempos.Cargue, modalidad);
        const descargue = metaDe(t.tiempos && t.tiempos.Descargue, modalidad);
        if (cargue && descargue) return umbralesTiempo(cargue + descargue);
    }

    return null;
}

/* =========================================================
   LA META PROMEDIO DE MUELLE DE LA BODEGA

   El promedio de las horas que las tipologías de ESTA bodega
   tienen configuradas para el muelle. No sirve para alertar
   —una alerta se dispara contra la meta del vehículo, no contra
   la de sus compañeros— pero sí para ORDENAR: un vehículo en
   muelle al que todavía nadie le asignó tipología no tiene meta
   propia contra la cual medirse, y dejarlo en cero lo mandaba al
   final de la fila de prioridad justo por el dato que le falta.

   Con el promedio de la bodega como referencia, ese vehículo se
   ordena contra lo que tarda un vehículo típico aquí. Cuenta las
   metas de arrumado y de paletizado por separado porque son dos
   tiempos reales distintos, no dos formas de escribir el mismo.

   Devuelve 0 cuando la bodega todavía no tiene ninguna meta
   configurada — ahí no hay nada que promediar y quien llame debe
   quedarse con el orden por tiempo transcurrido.
   ========================================================= */

export function metaPromedioMuelle(config) {

    let total = 0, n = 0;

    ((config && config.tipologias) || []).forEach(function (t) {
        TIPOS_OPERACION.forEach(function (op) {
            const tiempos = (t.tiempos && t.tiempos[op]) || {};
            if (tiempos.meta > 0) { total += tiempos.meta; n++; }
            if (tiempos.metaPaletizado > 0) { total += tiempos.metaPaletizado; n++; }
        });
    });

    return n ? Math.round(total / n) : 0;
}


/* =========================================================
   METAS EN HORAS Y MINUTOS

   Internamente una meta son minutos —es lo que se compara con
   los tiempos medidos— pero nadie las piensa así: las tablas de
   tiempos de las bodegas vienen escritas en HH:MM, y obligar a
   quien las carga a convertir 03:30 en 210 de cabeza es pedirle
   que se equivoque en una de cada diez.

   Se aceptan las dos formas al escribir: "03:30" y "210" dan lo
   mismo. Al pintar siempre se muestra HH:MM, que es como está la
   tabla de la que se copia.
   ========================================================= */

export function minutosDesdeHHMM(texto) {

    const v = String(texto == null ? "" : texto).trim();
    if (!v) return 0;

    // Sin ":" se toma como minutos sueltos, para no romperle la
    // mano a quien ya venía digitando así.
    if (v.indexOf(":") === -1) return Math.max(0, Math.round(Number(v) || 0));

    const partes = v.split(":");
    const h = Math.max(0, Math.round(Number(partes[0]) || 0));
    const m = Math.max(0, Math.round(Number(partes[1]) || 0));

    return h * 60 + m;
}

export function hhmmDesdeMinutos(minutos) {

    const n = Math.max(0, Math.round(Number(minutos) || 0));
    const h = Math.floor(n / 60);
    const m = n % 60;

    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
}


/* =========================================================
   VALIDACIÓN

   Devuelve un array de errores en texto plano, vacío si todo
   está bien. La validación vive aquí y no en el panel para que
   el día que se configure desde otra pantalla (o desde un
   script) no haya dos versiones de las mismas reglas.
   ========================================================= */

export function validarConfig(config, tarifas) {

    const errores = [];

    // El número de muelles no se valida contra cero: cero significa
    // "sin configurar" y deja a cada panel con el número que ya
    // traía. El tope es para atajar el dedo torpe que escribe 300
    // en vez de 3 y llena la pantalla de tarjetas vacías.
    if (config.muelles > 60) {
        errores.push("El número de muelles no puede pasar de 60.");
    }

    if (!(config.horaCorte >= 0 && config.horaCorte <= 23)) {
        errores.push("La hora de corte del turno debe estar entre 0 y 23.");
    }

    // Un campo sin rótulo es un campo que nadie sabe llenar.
    [
        { campo: "conductor", donde: "primer" },
        { campo: "cedula", donde: "segundo" }
    ].forEach(function (x) {
        const c = (config.campos && config.campos[x.campo]) || {};
        if (!c.etiqueta || !String(c.etiqueta).trim()) {
            errores.push("El " + x.donde + " campo de la entrada no tiene nombre.");
        }
    });

    if (!(config.limitePatio > 0)) {
        errores.push("El límite de patio debe ser mayor que cero.");
    }

    if (config.posicionesTotales < 0) {
        errores.push("Las posiciones totales no pueden ser negativas.");
    }

    // Un mínimo por encima de 100 dejaría al vehículo sin forma de
    // salir nunca; por debajo de 50 la "excepción" sería la regla.
    [
        { campo: "minimoCargue", nombre: "cargue" },
        { campo: "minimoDescargue", nombre: "descargue" }
    ].forEach(function (u) {
        const v = config[u.campo];
        if (!(v >= 50 && v <= 100)) {
            errores.push("El mínimo de " + u.nombre + " debe estar entre 50 y 100.");
        }
    });

    const pesos = config.pesosNivelServicio || {};
    if ((pesos.cita || 0) + (pesos.programacion || 0) !== 100) {
        errores.push("Los pesos del nivel de servicio deben sumar 100.");
    }

    if (config.horaReporteOcupacion &&
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.horaReporteOcupacion)) {
        errores.push("La hora del reporte de ocupación no tiene formato HH:MM.");
    }

    if (config.cobraVehiculos && tarifas) {
        const iva = tarifas.ivaPorcentaje;
        if (!(iva >= 0 && iva <= 100)) {
            errores.push("El porcentaje de IVA debe estar entre 0 y 100.");
        }
    }

    const nombresVistos = {};

    (config.tipologias || []).forEach(function (t, i) {

        const etiqueta = t.nombre ? '"' + t.nombre + '"' : "la tipología #" + (i + 1);

        if (!t.nombre || !t.nombre.trim()) {
            errores.push("La tipología #" + (i + 1) + " no tiene nombre.");
        } else {
            const clave = t.nombre.trim().toLowerCase();
            if (nombresVistos[clave]) {
                errores.push('Hay dos tipologías llamadas "' + t.nombre.trim() + '".');
            }
            nombresVistos[clave] = true;
        }

        // La tarifa se valida aquí aunque viva en otro documento: es
        // el único sitio que ve las dos mitades a la vez. Solo se
        // exige en las bodegas que cobran — en las demás la tipología
        // existe para medir tiempos, no para facturar.
        if (config.cobraVehiculos && tarifas) {

            const d = desglosarTarifa(tarifas, t.id);

            if (!(d.base > 0)) {
                errores.push("A " + etiqueta + " le falta el valor antes de IVA.");

            } else if (d.tasaInlo >= d.base) {
                // Con la tasa por encima del valor, la cuadrilla
                // cobraría cero o negativo: es un error de digitación,
                // no una decisión que alguien vaya a tomar a propósito.
                errores.push("En " + etiqueta + ", la tasa de ganancia INLO (" + d.tasaInlo +
                    ") no puede ser mayor ni igual que el valor antes de IVA (" + d.base + ").");
            }
        }

        // Los tiempos no se validan porque ya no pueden quedar mal:
        // cada operación lleva un solo número, y los umbrales salen
        // de él con umbralesTiempo(). Antes había que comprobar que
        // el rojo no llegara antes que el amarillo — un error que
        // hoy no se puede cometer.
        //
        // La meta tampoco es obligatoria: `tiemposDe()` trata el
        // cero como "sin configurar", y exigirla dejaba la tabla de
        // tarifas sin poder guardarse hasta medir tiempos que nadie
        // ha medido todavía.
    });

    return errores;
}


/* =========================================================
   LECTURA Y ESCRITURA — configuración pública de la bodega
   ========================================================= */

export async function obtenerConfig(operacion) {
    const snap = await getDoc(doc(db, COLECCION, operacion));
    return normalizar(operacion, snap.exists() ? snap.data() : null);
}

/*
    Suscripción en vivo. Los paneles la usan en vez de leer una
    sola vez porque si el administrador crea una tipología con la
    portería abierta, el formulario de entrada debe ofrecerla sin
    que el operario recargue la página.

    Devuelve la función `unsubscribe`.
*/
export function suscribirseAConfig(operacion, callback) {

    return onSnapshot(doc(db, COLECCION, operacion), function (snap) {
        callback(normalizar(operacion, snap.exists() ? snap.data() : null));
    }, function (error) {
        console.error("Error al escuchar la configuración de " + operacion + ":", error);
        callback(null, error);
    });
}

export async function guardarConfig(operacion, config, admin) {

    const limpio = normalizar(operacion, config);

    await setDoc(doc(db, COLECCION, operacion), {
        operacion: operacion,
        cliente: limpio.cliente,
        muelles: limpio.muelles,
        primerMuelle: limpio.primerMuelle,
        horaCorte: limpio.horaCorte,
        campos: limpio.campos,
        manejaCancelaciones: limpio.manejaCancelaciones,
        distingueModalidad: limpio.distingueModalidad,
        cobraVehiculos: limpio.cobraVehiculos,
        limitePatio: limpio.limitePatio,
        minimoCargue: limpio.minimoCargue,
        minimoDescargue: limpio.minimoDescargue,
        capacidadDiaria: limpio.capacidadDiaria,
        posicionesTotales: limpio.posicionesTotales,
        horaReporteOcupacion: limpio.horaReporteOcupacion,
        pesosNivelServicio: limpio.pesosNivelServicio,
        tipologias: limpio.tipologias,
        actualizadoEn: serverTimestamp(),
        actualizadoPor: admin || ""
    });
}


/* =========================================================
   TARIFAS — el desglose

   De cada tipología se guardan DOS números y nada más:

       base      el valor antes de IVA, que es lo que se cobra
                 cuando el soporte es un recibo de caja menor
       tasaInlo  lo que se queda INLOTRANS de ese valor

   Todo lo demás se calcula: el IVA, el valor con IVA (lo que se
   cobra cuando se entrega factura) y lo que se le paga a la
   cuadrilla. No se guardan porque un derivado guardado es un
   derivado que puede quedar descuadrado — exactamente el riesgo
   que corre la hoja de cálculo el día que alguien pisa una
   fórmula con un número escrito a mano.

   El mapa va por id de tipología y no como array para que
   agregar o quitar tipologías no obligue a reordenar nada, y
   para que una tipología borrada por error no arrastre la tarifa
   de otra al recuperarla.
   ========================================================= */

export function tarifasPorDefecto() {
    return { ivaPorcentaje: IVA_POR_DEFECTO, valores: {} };
}

/*
    Antes la tarifa era un número suelto por tipología. Un
    documento guardado así se lee como el valor antes de IVA, sin
    tasa de ganancia: es la lectura que no inventa plata que nadie
    escribió, y deja el campo visible en el panel para completarlo.
*/
function normalizarTarifa(valor) {

    if (valor === null || valor === undefined) return { base: 0, tasaInlo: 0 };

    if (typeof valor !== "object") {
        return { base: numeroODefecto(valor, 0), tasaInlo: 0 };
    }

    return {
        base: numeroODefecto(valor.base, 0),
        tasaInlo: numeroODefecto(valor.tasaInlo, 0)
    };
}

export function normalizarTarifas(datos) {

    const valores = {};
    const origen = (datos && datos.valores) || {};

    Object.keys(origen).forEach(function (id) {
        valores[id] = normalizarTarifa(origen[id]);
    });

    return {
        ivaPorcentaje: numeroODefecto(datos && datos.ivaPorcentaje, IVA_POR_DEFECTO),
        valores: valores
    };
}

/*
    Las cinco cifras de la tabla para una tipología. Devuelve
    siempre el objeto completo —con ceros si no hay tarifa— para
    que quien lo pinta no tenga que repetir las fórmulas.

    Se redondea a peso entero: las tarifas de portería no usan
    centavos y arrastrarlos solo ensucia el arqueo de la caja.
*/
export function desglosarTarifa(tarifas, tipologiaId) {

    const t = normalizarTarifa(tarifas && tarifas.valores ? tarifas.valores[tipologiaId] : null);
    const ivaPorcentaje = numeroODefecto(tarifas && tarifas.ivaPorcentaje, IVA_POR_DEFECTO);
    const iva = Math.round(t.base * ivaPorcentaje / 100);

    return {
        base: t.base,
        ivaPorcentaje: ivaPorcentaje,
        iva: iva,
        conIva: t.base + iva,
        tasaInlo: t.tasaInlo,

        // Lo que le queda a la cuadrilla después de la tasa. Nunca
        // negativo: la validación lo impide al guardar, pero un
        // documento viejo podría traerlo y no vale la pena mostrar
        // una cifra en rojo que nadie sabría interpretar.
        cuadrilla: Math.max(0, t.base - t.tasaInlo)
    };
}


/* =========================================================
   LECTURA Y ESCRITURA — tarifas (restringido)

   `obtenerTarifas` devuelve las tarifas vacías cuando el rol que
   llama no tiene permiso. Eso NO es un error a mostrar: es el
   caso normal cuando la función se invoca desde un panel
   compartido que también usa el operario. Quien necesite
   distinguir "sin tarifas configuradas" de "sin permiso para
   verlas" debe usar `permitido`.
   ========================================================= */

export async function obtenerTarifas(operacion) {

    try {
        const ref = doc(db, COLECCION, operacion, SUB_PRIVADO, DOC_TARIFAS);
        const snap = await getDoc(ref);
        return { tarifas: normalizarTarifas(snap.exists() ? snap.data() : null), permitido: true };

    } catch (error) {
        if (error && error.code === "permission-denied") {
            return { tarifas: tarifasPorDefecto(), permitido: false };
        }
        throw error;
    }
}

export async function guardarTarifas(operacion, tarifas, admin) {

    const limpio = normalizarTarifas(tarifas);
    const ref = doc(db, COLECCION, operacion, SUB_PRIVADO, DOC_TARIFAS);

    await setDoc(ref, {
        ivaPorcentaje: limpio.ivaPorcentaje,
        valores: limpio.valores,
        actualizadoEn: serverTimestamp(),
        actualizadoPor: admin || ""
    });
}
