/* =========================================================
   INLOTRANS — Panel de ADMINISTRADOR

   Reconstruido a partir del index.html original ("Control de
   Portería"), preservando TODAS sus funcionalidades
   (Dashboard, Registro, Registros con filtros, modales de
   salida/edición/detalle, exportar), pero:

     - Sin el "gate" de elegir operador de una lista. El
       operador es quien inició sesión (guard.js + perfil de
       Firestore).
     - Sin localStorage como base de datos ni Realtime
       Database. Todo pasa por shared/services/vehiculos.js
       (Firestore), en tiempo real (onSnapshot).
     - "Estadísticas" y "Configurar Firebase" NO están aquí:
       las estadísticas se construyen en supervisor/clientes
       (con datos de más de una fuente), y la configuración de
       Firebase ya no es manual — vive en shared/core/firebase.js.
   ========================================================= */

import { protegerPagina } from "../shared/core/guard.js";
import { cerrarSesionFirebase } from "../shared/core/auth.js";
import { cerrarSesionLocal } from "../shared/core/session.js";

import {
    crearRegistro,
    suscribirseARegistros,
    actualizarUbicacion,
    registrarSalida,
    agregarObservacion,
    eliminarRegistro as eliminarRegistroFirestore,
    getMuellesOcupacion,
    getMuellesLibres,
    getRegistrosEnMuelle,
    getRegistrosEnPatio,
    requiereAvanceCompleto,
    diagnosticoSalida,
    agregarOperacionFaltante,
    actualizarAvance,
    avanzarAFaseCargue,
    autorizarSalidaAnticipada,
    puedeAutorizarSalidaAnticipada,
    cancelarVehiculo,
    crearCitaCancelada,
    corregirRegistro,
    actualizarModalidad,
    estaCancelado
} from "../shared/services/vehiculos.js";

import {
    canalDe,
    getDestino,
    getHistorial,
    getLocationDurations,
    minutosEnPatio,
    minutosEnMuelle,
    nivelContraMeta,
    faseActual,
    minutosEsperando,
    nivelPrioridad,
    UMBRALES_PATIO_POR_DEFECTO,
    promedioMinutos,
    ordenarPorPrioridad,
    prioridadDe,
    enMuelleFueraDeMeta,
    diaConMasMovimiento,
    tituloHistorial,
    getDiaOperativo
} from "../shared/services/eventos.js";

import {
    TIPOS_OPERACION,
    obtenerConfig,
    obtenerTarifas,
    guardarConfig,
    guardarTarifas,
    validarConfig,
    nuevaTipologia,
    buscarTipologia,
    hayTipologias,
    numerosDeMuelle,
    umbralesPatio,
    umbralesTiempo,
    tiemposDe,
    tarifasPorDefecto,
    desglosarTarifa,
    etiquetaCampo,
    formatoCampo,
    limpiarSegunFormato,
    errorDeFormato,
    minutosDesdeHHMM,
    hhmmDesdeMinutos,
    distingueModalidad,
    modalidadDe,
    MODALIDADES
} from "../shared/services/config.js";

import {
    MEDIOS_PAGO,
    SOPORTES_PAGO,
    SOPORTE_POR_DEFECTO,
    soporteEntraACaja,
    soporteDe,
    tarifaDeSoporte,
    repartir,
    validarCobro,
    registrarCobro,
    suscribirseACobros,
    pendientesDeCobro,
    sinTipologia,
    resumenCaja
} from "../shared/services/cobros.js";

import { fichaVehiculo } from "../shared/services/detalleVehiculo.js";

import { nowLocal, today, fmtDt, formatDuration, fechaDentroDeRango, todayOperativo, sumarDias } from "../shared/utils/tiempos.js";
import { exportarExcel } from "../shared/utils/excel.js";
import { renderPanelEstadisticas, renderChartFranjaHoraria } from "../shared/services/estadisticas.js";

/* Bodegas que administra este panel. El admin no está atado a una
   sola operación: el selector del topbar cambia `operacionActual` y
   todo el panel (muelles, registros, estadísticas) se recarga.

   El nombre del cliente y el número de muelles YA NO SE LEEN DE
   AQUÍ salvo que la bodega no los tenga configurados: ahora viven
   en config/{operacion} y se editan desde la vista de
   Configuración. Este mapa quedó como el valor de partida —lo que
   el sistema ha venido usando— para que una bodega que todavía no
   se ha tocado siga viéndose igual.

   Al agregar una bodega nueva hay que sumarla a este mapa, porque
   es también la lista de las que existen. */
const OPERACIONES = {
    J3: { nombre: "Pepsico", muelles: 8 },
    J4: { nombre: "Alkosto", muelles: 3 },
    B9: { nombre: "EMMA",    muelles: 4 }
};

const HORA_CORTE_POR_DEFECTO = 6;
const STORAGE_OPERACION = "inlotrans_admin_operacion";

/* chartjs-plugin-datalabels viene cargado desde dashboard.html. Se
   registra UNA vez, deshabilitado por defecto: cada gráfica lo
   activa explícitamente en su config (options.plugins.datalabels),
   que es lo que ya hacen las de estadisticas.js.

   Sin esto las cifras solo salían en el tooltip — el tooltip es de
   Chart.js, pero rotular la barra es cosa del plugin—, y las mismas
   gráficas se veían con menos información aquí que en supervisor y
   cliente, que sí lo registraban.

   Una sola vez: registrar el mismo plugin dos veces hace que
   Chart.js avise por consola. */
if (typeof Chart !== "undefined" && typeof ChartDataLabels !== "undefined") {
    Chart.register(ChartDataLabels);
    Chart.defaults.set("plugins.datalabels", { display: false });
}

// Operación que se está viendo. Se recuerda entre recargas para
// que el admin no tenga que volver a elegirla en cada visita.
let operacionActual = localStorage.getItem(STORAGE_OPERACION) || "J3";
if (!OPERACIONES[operacionActual]) operacionActual = "J3";

/* =========================================================
   COLOR DE LA BODEGA ABIERTA

   Cada bodega tiene su color —J3 azul, J4 naranja, B9 verde— y de
   los cuatro paneles este es el único donde cambia sin recargar la
   página: el administrador salta de una a otra con el selector del
   topbar y todo lo que ve (registros, muelles, caja, tarifas) pasa
   a ser de otra operación.

   Ese salto es exactamente el momento peligroso: la pantalla se ve
   igual antes y después, y registrar una entrada creyendo que se
   sigue en la bodega anterior es un error que nadie nota hasta que
   el camión no aparece en el reporte. El cambio de color es lo que
   lo hace evidente sin tener que leer el selector.

   Los colores de cada bodega viven en css/base.css; aquí solo se
   dice cuál está abierta. El primer valor lo pone el <script> del
   <head> de dashboard.html, antes del primer pintado — ver el
   comentario de allá.
   ========================================================= */

function aplicarColorDeBodega(operacion) {
    // Una bodega que no esté en el mapa se queda sin atributo, y con
    // él en el color por defecto: es preferible el naranja de siempre
    // a un `data-operacion` inventado que no case con ningún bloque
    // de base.css y deje media pantalla sin color.
    if (OPERACIONES[operacion]) {
        document.documentElement.setAttribute("data-operacion", operacion);
    } else {
        document.documentElement.removeAttribute("data-operacion");
    }
}

aplicarColorDeBodega(operacionActual);

/* Los tres datos de identidad se leen de la configuración GUARDADA
   —nunca del borrador— porque mandan sobre el panel entero: el
   tablero de muelles no puede reorganizarse mientras alguien está
   escribiendo el número en el formulario de al lado. */

function numMuelles() {
    return (cfgGuardada && cfgGuardada.muelles) || OPERACIONES[operacionActual].muelles;
}

/* Los números REALES de los muelles de la bodega abierta, en orden.
   No siempre son 1..N: los de J4 son el 9, el 10 y el 11. */
function numerosMuelle() {
    return numerosDeMuelle(cfgGuardada, numMuelles());
}

function clienteActual() {
    return (cfgGuardada && cfgGuardada.cliente) || OPERACIONES[operacionActual].nombre;
}

function horaCorte() {
    return cfgGuardada && cfgGuardada.horaCorte != null
        ? cfgGuardada.horaCorte
        : HORA_CORTE_POR_DEFECTO;
}

/* Cómo llama esta bodega a los dos campos libres del registro: en
   J3 y B9, conductor y cédula; en J4, proveedor y número de cita.
   Se lee de la configuración guardada, no del borrador: renombrar
   un campo a media escritura cambiaría las tablas de atrás. */
function rotulo(campo) {
    return etiquetaCampo(cfgGuardada, campo);
}

/* Los dos rótulos juntos, que es como los piden la ficha del
   vehículo y la hoja de Excel. */
function etiquetasCampos() {
    return { conductor: rotulo('conductor'), cedula: rotulo('cedula') };
}

function manejaCancelaciones() {
    return !!(cfgGuardada && cfgGuardada.manejaCancelaciones);
}

/* Si la bodega abierta cobra. Sale de la configuración GUARDADA y
   no del borrador, igual que los demás datos que mandan sobre el
   panel: lo que decide qué se muestra es lo publicado, no lo que
   alguien tenga a medio escribir en el formulario de al lado. */
function bodegaCobraActual() {
    return !!(cfgGuardada && cfgGuardada.cobraVehiculos);
}

/* Los umbrales de espera en patio de la bodega abierta. Salen de la
   configuración guardada, igual que en portería y supervisor: si el
   administrador midiera la alerta contra otro número que el que él
   mismo configuró, su tablero y el de la bodega dirían cosas
   distintas del mismo patio. */
function umbralesDePatio() {
    return cfgGuardada ? umbralesPatio(cfgGuardada) : UMBRALES_PATIO_POR_DEFECTO;
}

/* Un día operativo (YYYY-MM-DD) en formato corto para las tarjetas.
   T00:00:00 y no el string pelado: sin la hora, el navegador lo lee
   como UTC y en Colombia lo pinta un día antes. */
function fmtDiaCorto(diaOp) {
    return new Date(diaOp + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit' });
}
const RUTA_LOGIN = "../index.html";

let registros = [];
let selectedId = null;
let currentFilter = 'todos';
let unsubscribeRegistros = null;
let perfilActual = null;

/* =========================================================
   FILTRO GLOBAL DE CANAL (Dashboard + Registros + Estadísticas)

   Lo tenían supervisor y cliente en su barra superior y aquí no:
   el administrador solo podía filtrar por canal DENTRO de la caja
   de cumplimiento de cita, así que para mirar la operación de 3PD
   completa no tenía cómo.

   Es UNO solo, no dos: el desplegable del topbar y el de la caja de
   on time escriben la misma variable y se sincronizan entre sí. Dos
   filtros de canal en la misma pantalla, cada uno recortando una
   parte, es la forma segura de leer dos universos distintos creyendo
   que son el mismo.

   Los COBROS quedan fuera a propósito: la caja del turno se cuadra
   completa, no por canal, y filtrarla dejaría un arqueo que no
   coincide con el dinero que hay en el cajón. Es la misma decisión
   que ya tomó el panel de supervisor.
   ========================================================= */

let canalFiltro = '';

function registrosFiltrados() {
    if (!canalFiltro) return registros;
    // canalDe() normaliza: los registros viejos que quedaron en
    // "Sin canal" cuentan como "Otro", que es la opción que hoy
    // ofrece el formulario.
    return registros.filter(function (r) { return canalDe(r) === canalFiltro; });
}

/* Deja los dos desplegables diciendo lo mismo, venga el cambio del
   que venga. */
function sincronizarSelectoresCanal() {
    ['filtro-canal', 'ontime-canal'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.value !== canalFiltro) el.value = canalFiltro;
    });
}

/* Cobros de la bodega abierta, como mapa { vehiculoId: cobro }.
   Alimentan el bloque de caja de las estadísticas. */
let cobros = {};
let unsubscribeCobros = null;


/* =========================================================
   TOAST
   ========================================================= */

function toast(msg, type, icon) {
    type = type || 'blue';
    icon = icon || 'ti-check';
    var t = document.getElementById('toast');
    t.innerHTML = '<i class="ti ' + icon + '"></i>' + msg;
    t.className = 'toast show ' + type;
    clearTimeout(t._to);
    t._to = setTimeout(function () { t.className = 'toast'; }, 2800);
}

function setSyncStatus(status) {
    var el = document.getElementById('sync-indicator');
    if (!el) return;
    if (status === 'syncing') {
        el.className = 'sync-badge syncing';
        el.innerHTML = '<i class="ti ti-loader-2"></i> Guardando…';
    } else if (status === 'error') {
        el.className = 'sync-badge error';
        el.innerHTML = '<i class="ti ti-alert-triangle"></i> Error al guardar';
    } else {
        el.className = 'sync-badge';
        el.innerHTML = '<i class="ti ti-cloud-check"></i> Conectado';
    }
}

function initials(name) {
    return (name || '').split(' ').map(function (p) { return p[0]; }).slice(0, 2).join('').toUpperCase();
}


/* =========================================================
   SANEAMIENTO DE CAMPOS DE TEXTO

   Igual que con la hora: se filtra en cada tecla ('input'), no
   solo al guardar, para que el campo nunca llegue a mostrar un
   valor que no tiene sentido para lo que representa.
   ========================================================= */

/* Los dos campos libres se filtran según lo que su formato admite,
   y ese formato lo pone la configuración de cada bodega: el nombre
   de un conductor no lleva números, pero el de un proveedor sí
   puede ("Distribuidora 3M S.A.S."). */
function filtrarSegunFormato(e, campo) {
    e.target.value = limpiarSegunFormato(e.target.value, formatoCampo(cfgGuardada, campo));
}


/* =========================================================
   ENTRADA DE HORA EN 24H (sin am/pm)

   Los <input type="datetime-local"/time> nativos muestran
   am/pm o 24h según el sistema operativo del dispositivo, algo
   que no se puede forzar desde la página. Por eso las horas se
   capturan con campos numéricos separados de Hora (0-23) y
   Minuto (0-59) — así el formato de entrada queda garantizado
   sin depender del navegador.
   ========================================================= */

function dosDigitos(valor, max) {
    if (valor === '' || valor === null || valor === undefined) return null;
    var n = parseInt(valor, 10);
    if (isNaN(n) || n < 0 || n > max) return null;
    return (n < 10 ? '0' : '') + n;
}

function horaFueraDeRango(horaId, minId) {
    var hRaw = document.getElementById(horaId).value;
    var mRaw = document.getElementById(minId).value;
    return (hRaw !== '' && dosDigitos(hRaw, 23) === null) || (mRaw !== '' && dosDigitos(mRaw, 59) === null);
}

// Se aplica en cada tecla (evento 'input'): además del min/max del HTML
// (que no bloquea lo que se escribe a mano), esto impide que el campo
// llegue a mostrar un valor fuera de rango — corrige en el momento, no
// después de guardar, así el operador ve exactamente lo que va a quedar.
function limitarHora(e, max) {
    var v = e.target.value.replace(/[^0-9]/g, '').slice(0, 2);
    var n = v === '' ? null : parseInt(v, 10);
    if (n !== null && n > max) v = String(max);
    e.target.value = v;
}

function leerFechaHora(fechaId, horaId, minId) {
    var fecha = document.getElementById(fechaId).value;
    var hh = dosDigitos(document.getElementById(horaId).value, 23);
    var mm = dosDigitos(document.getElementById(minId).value, 59);
    if (!fecha || hh === null || mm === null) return '';
    return fecha + 'T' + hh + ':' + mm;
}

function escribirFechaHora(fechaId, horaId, minId, valorISO) {
    var partes = (valorISO || '').split('T');
    document.getElementById(fechaId).value = partes[0] || '';
    var hm = (partes[1] || '').split(':');
    document.getElementById(horaId).value = hm[0] !== undefined ? parseInt(hm[0], 10) : '';
    document.getElementById(minId).value = hm[1] !== undefined ? parseInt(hm[1], 10) : '';
}

function leerHora(horaId, minId) {
    var hh = dosDigitos(document.getElementById(horaId).value, 23);
    var mm = dosDigitos(document.getElementById(minId).value, 59);
    if (hh === null || mm === null) return '';
    return hh + ':' + mm;
}

function limpiarHora(horaId, minId) {
    document.getElementById(horaId).value = '';
    document.getElementById(minId).value = '';
}

// guard.js no expone una función de logout, así que la armamos aquí
// con las mismas piezas que usa internamente (auth.js + session.js).
function salir() {
    cerrarSesionFirebase()
        .catch(function () {})
        .finally(function () {
            cerrarSesionLocal();
            window.location.href = RUTA_LOGIN;
        });
}


/* =========================================================
   NAVEGACIÓN ENTRE VISTAS
   ========================================================= */

function showView(v) {
    document.querySelectorAll('.view').forEach(function (el) { el.classList.remove('active'); });
    document.querySelectorAll('.nav-item[data-view]').forEach(function (el) { el.classList.remove('active'); });

    document.getElementById('view-' + v).classList.add('active');

    var navBtn = document.querySelector('.nav-item[data-view="' + v + '"]');
    if (navBtn) navBtn.classList.add('active');

    var titulos = { dashboard: 'Dashboard', entrada: 'Registrar entrada', registros: 'Registros', estadisticas: 'Estadísticas', cobros: 'Cobros', configuracion: 'Configuración', exportar: 'Exportar datos' };
    document.getElementById('topbar-title').textContent = titulos[v] || v;

    // La configuración se relee al abrir la vista: puede haberla
    // cambiado otro administrador desde que se cargó la página.
    // Si hay un borrador con cambios sin guardar, se respeta.
    if (v === 'configuracion' && !cfgHayCambios()) cargarConfiguracion();

    renderTodo();
    closeSidebar();
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('visible');
}
function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('visible');
}


/* =========================================================
   RENDER GENERAL (se llama cada vez que cambian los datos o la vista)
   ========================================================= */

function renderTodo() {
    document.getElementById('sidebar-count').textContent = registros.length + ' registro' + (registros.length !== 1 ? 's' : '');
    renderDashboard();
    renderRegistros();
    renderEstadisticas();
    renderCobros();
    // Solo el aviso, no el formulario: repintarlo entero mientras
    // alguien escribe le borraría lo que va digitando.
    renderCfgAlertaVacia();
}


/* =========================================================
   DASHBOARD
   ========================================================= */

/* Promedio de tiempo en una tarjeta del dashboard: "—" cuando no hay
   ninguna visita terminada que promediar (0 min se leería como "salen
   al instante"), y el tamaño de la muestra al lado, para que un
   promedio sobre un vehículo no se vea igual que uno sobre cuarenta. */
function pintarPromedio(id, p) {
    var el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = p.promedio === null
        ? '—'
        : formatDuration(p.promedio) + ' <span class="prom-n">(' + p.n + ')</span>';
}


function renderDashboard() {

    if (!document.getElementById('view-dashboard').classList.contains('active')) return;

    // Todo el tablero respeta el filtro de canal del topbar, igual que
    // en supervisor y cliente.
    var base = registrosFiltrados();

    var enPatio = getRegistrosEnPatio(base);
    var enMuelle = getRegistrosEnMuelle(base);
    var activos = base.filter(function (r) { return !r.horaSalida; });

    document.getElementById('s-total').textContent = activos.length;
    document.getElementById('s-patio').textContent = enPatio.length;
    document.getElementById('s-muelle').textContent = enMuelle.length;

    // Promedios del DÍA OPERATIVO en curso, con la misma regla que el
    // panel de supervisor (promedioMinutos en shared/services/eventos.js):
    // solo visitas terminadas, y solo las que pasaron por esa ubicación.
    //
    // Antes se promediaban TODOS los registros históricos de la operación
    // —más de mil— y encima con el cronómetro abierto de los que seguían
    // adentro. Por eso al lado de "En patio: 0" podía leerse "Tiempo prom.
    // patio: 12h 58min": no era el patio de hoy, era el de toda la
    // historia, y no coincidía con nada de lo que muestra el supervisor.
    var diaOp = todayOperativo(horaCorte());
    var deHoy = base.filter(function (r) { return getDiaOperativo(r, horaCorte()) === diaOp; });
    pintarPromedio('s-tiempo-patio', promedioMinutos(deHoy, 'patio'));
    pintarPromedio('s-tiempo-muelle', promedioMinutos(deHoy, 'muelle'));

    /* Los indicadores que hasta ahora solo tenían supervisor y
       cliente. El administrador responde por las tres bodegas y era
       justamente el único que no los veía: tenía que entrar al panel
       de otro rol para saber cuántos vehículos estaban en alerta. */
    document.getElementById('kpi-hoy').textContent = deHoy.length;
    document.getElementById('kpi-alerta').textContent =
        enPatio.filter(function (r) { return nivelPrioridad(minutosEsperando(r), umbralesDePatio()) === 'alta'; }).length;
    document.getElementById('kpi-alerta-muelle').textContent =
        enMuelleFueraDeMeta(enMuelle, cfgGuardada).length;

    var mejorDia = diaConMasMovimiento(base, horaCorte());
    document.getElementById('kpi-mejor-dia-fecha').textContent =
        mejorDia ? fmtDiaCorto(mejorDia.dia) : '—';
    document.getElementById('kpi-mejor-dia-detalle').textContent = mejorDia
        ? mejorDia.total + ' movimientos (' + mejorDia.entradas + ' entradas · ' + mejorDia.salidas + ' salidas)'
        : 'Sin datos todavía';

    renderPrioridades(enPatio);

    // Banner: vehículos con más de 4h en patio
    var retrasados = enPatio.filter(function (r) { return minutosEnPatio(r) >= 240; });
    var banner = document.getElementById('alerta-patio-banner');
    if (retrasados.length) {
        banner.style.display = 'flex';
        document.getElementById('alerta-patio-detalle').textContent =
            retrasados.length + ' vehículo(s) han superado 4h en patio: ' + retrasados.map(function (r) { return r.placa; }).join(', ');
    } else {
        banner.style.display = 'none';
    }

    // Banner de tiempo en muelle. Es OTRA alerta, no la misma con
    // otro número: la de arriba mide la espera en patio, y esta mide
    // lo que cada vehículo lleva EN MUELLE contra la meta que el
    // propio administrador le fijó a su tipología en Configuración.
    pintarAlertaMuelle(enMuelle);

    // Grilla de muelles
    // Object.keys y no la lista: si un vehículo quedó en un muelle
    // que ya no está en la numeración, getMuellesOcupacion lo agrega
    // al final y aquí se sigue viendo hasta que salga.
    var ocupacion = getMuellesOcupacion(enMuelle, numerosMuelle());
    var htmlGrid = '';
    Object.keys(ocupacion).forEach(function (n) {
        var rec = ocupacion[n];

        // La alerta del muelle sale de la meta de la tipología del
        // vehículo, no de un umbral igual para todos.
        var nivel = rec ? nivelMuelle(rec) : 'normal';

        htmlGrid += '<div class="muelle-card ' + (rec ? 'ocupado' : 'libre') +
            (nivel !== 'normal' ? ' muelle-' + nivel : '') + '">' +
            '<div class="muelle-card-top">' +
                '<span class="muelle-card-num">Muelle ' + n + '</span>' +
                '<span class="muelle-card-status ' + (rec ? 'ocupado' : 'libre') + '">' + (rec ? 'OCUPADO' : 'LIBRE') + '</span>' +
            '</div>' +
            (rec ? avisoMetaMuelle(rec) : '') +
            '<div class="muelle-card-body">' +
                (rec
                    ? '<div class="muelle-card-placa">' + rec.placa + '</div><div>' + rec.conductor + '</div>' +
                      selectorModalidad(rec) +
                      renderAvance(rec) +
                      '<div style="margin-top:6px;display:flex;gap:4px;">' +
                        '<button class="btn btn-sm btn-primary" data-editar="' + rec.id + '">Mover</button>' +
                        '<button class="btn btn-sm" data-observacion="' + rec.id + '" title="Agregar observación"><i class="ti ti-message-plus"></i></button>' +
                        '<button class="btn btn-sm btn-danger" data-salida="' + rec.id + '"' + attrsBotonSalida(rec) + '>Salida</button>' +
                        '<button class="btn btn-sm" data-detalle="' + rec.id + '"><i class="ti ti-info-circle"></i></button>' +
                      '</div>'
                    : '<div class="muelle-card-empty">Disponible</div>') +
            '</div></div>';
    });
    document.getElementById('muelles-grid').innerHTML = htmlGrid;

    // Tabla de patio
    var tbody = document.getElementById('dash-table');
    var enPatioOrd = ordenarPorPrioridad(enPatio, cfgGuardada);
    if (!enPatioOrd.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No hay vehículos en patio actualmente.</td></tr>';
    } else {
        tbody.innerHTML = enPatioOrd.map(function (r, idx) {
            return '<tr>' +
                '<td>' + badgePrioridad(r, idx + 1) + '</td>' +
                '<td class="td-placa">' + r.placa + '</td>' +
                '<td>' + r.conductor + '</td>' +
                '<td><span class="badge badge-cargue">' + r.tipo + '</span></td>' +
                '<td>' + fmtDt(r.horaEntrada) + '</td>' +
                '<td>' + (r.operadorEntrada || '—') + '</td>' +
                '<td><button class="btn btn-sm btn-primary" data-editar="' + r.id + '">Mover</button> ' +
                    '<button class="btn btn-sm" data-observacion="' + r.id + '" title="Agregar observación"><i class="ti ti-message-plus"></i></button> ' +
                    '<button class="btn btn-sm" data-detalle="' + r.id + '"><i class="ti ti-info-circle"></i></button></td>' +
            '</tr>';
        }).join('');
    }

    /* Franja horaria y últimos movimientos: los dos bloques con los
       que cierran el tablero supervisor y cliente. La gráfica se pinta
       con la MISMA función compartida que ellos, para que las tres
       pantallas no puedan mostrar horas pico distintas. */
    renderChartFranjaHoraria('chart-franja-horaria-dashboard', deHoy, horaCorte());
    renderUltimosMovimientos(base);
}

/* Reparte los vehículos que esperan en patio según su nivel de
   prioridad. Es el bloque del panel del cliente: dice si los que
   esperan son muchos, o si son pocos pero llevan demasiado. */
function renderPrioridades(enPatio) {
    var conteo = { normal: 0, media: 0, alta: 0 };
    enPatio.forEach(function (r) {
        conteo[nivelPrioridad(minutosEsperando(r), umbralesDePatio())]++;
    });
    document.getElementById('prioridad-normal').textContent = conteo.normal;
    document.getElementById('prioridad-media').textContent = conteo.media;
    document.getElementById('prioridad-alta').textContent = conteo.alta;
}

/* Los quince más urgentes, patio y muelle mezclados, con el mismo
   orden de prioridad del resto del panel: el que está en muelle
   corre contra la meta de su tipología y el que espera contra el
   límite de patio (ver prioridadDe en eventos.js). */
function renderUltimosMovimientos(base) {

    var tbody = document.getElementById('tabla-dashboard-body');
    if (!tbody) return;

    var ultimos = ordenarPorPrioridad(base || registros, cfgGuardada).slice(0, 15);

    if (!ultimos.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Sin registros por ahora.</td></tr>';
        return;
    }

    tbody.innerHTML = ultimos.map(function (r) {
        var activo = !r.horaSalida;
        var p = prioridadDe(r, cfgGuardada);
        var etiqueta = p.nivel === 'alta' ? 'Urgente' : p.nivel === 'media' ? 'Atención' : 'Normal';
        return '<tr>' +
            '<td class="td-placa">' + escapar(r.placa) + '</td>' +
            '<td>' + escapar(r.conductor || '—') + '</td>' +
            '<td>' + fmtDt(r.horaEntrada) + '</td>' +
            '<td>' + escapar(getDestino(r)) + '</td>' +
            '<td>' + (activo ? formatDuration(p.minutos) : '—') + '</td>' +
            '<td>' + (activo
                ? '<span class="badge badge-prioridad-' + p.nivel + '" title="' + tituloPrioridad(p) + '">' + etiqueta + '</span>'
                : badgeEstado(r)) +
            '</td>' +
        '</tr>';
    }).join('');
}


/* =========================================================
   CÓMO VIENE LA MERCANCÍA

   Arrumada (bulto a bulto) o paletizada (en estibas). De eso cuelga
   la meta de tiempo en muelle, así que marcarlo mueve la alerta en
   el acto.

   Estaba solo en el supervisor de J3 —la única bodega que hoy lo
   distingue— y por eso el administrador podía CONFIGURAR las dos
   metas pero no decir cuál aplicaba a un vehículo concreto. Aquí
   los botones aparecen donde `distingueModalidad` esté encendido,
   sea la bodega que sea.
   ========================================================= */

function selectorModalidad(r) {

    if (!distingueModalidad(cfgGuardada)) return '';

    var actual = modalidadDe(r);

    var botones = MODALIDADES.map(function (m) {
        return '<button class="btn btn-sm' + (m === actual ? ' btn-primary' : '') +
               '" data-modalidad="' + r.id + ':' + m + '">' + m + '</button>';
    }).join('');

    // "sin marcar" y no un check: hasta que alguien lo diga, lo que
    // rige es el supuesto, no una confirmación.
    var nota = r.modalidad ? '' : ' <span style="color:var(--text-3);">(sin marcar — se asume arrumado)</span>';

    return '<div class="avance-box"><span class="avance-label">¿Cómo viene la mercancía?' + nota + '</span>' +
           '<div style="display:flex;gap:4px;">' + botones + '</div></div>';
}

async function marcarModalidad(id, modalidad) {
    try {
        await actualizarModalidad(id, modalidad, perfilActual.nombre);
        toast('Mercancía marcada como ' + modalidad, 'blue', 'ti-packages');
    } catch (error) {
        console.error('No se pudo marcar la modalidad:', error);
        toast('No se pudo marcar la modalidad', 'red', 'ti-alert-triangle');
    }
}

/* =========================================================
   ALERTAS DE MUELLE (meta por tipología)

   La segunda alerta del tablero, separada de la de patio a
   propósito: aquella avisa de la cola de afuera contra el límite
   general de la bodega; esta avisa del vehículo que YA ESTÁ
   operando y se pasó de las horas que el administrador le fijó a
   su tipología en la vista de Configuración de este mismo panel.
   ========================================================= */

function nivelMuelle(r) {
    return nivelContraMeta(
        minutosEnMuelle(r),
        tiemposDe(cfgGuardada, r.tipologia, faseActual(r), modalidadDe(r))
    );
}

/* Cuánto lleva en muelle y contra qué meta. Se muestra siempre que
   haya meta, no solo al pasarse: ver que va en 40 de 105 minutos
   dice que va bien; enterarse solo cuando ya es tarde, no.

   Sin meta lo dice en voz alta: un muelle sin cifra se lee como
   "va bien", y lo que pasa es que ese vehículo no tiene tipología
   asignada — que es justo lo que hay que ir a corregir. */
function avisoMetaMuelle(r) {

    var meta = tiemposDe(cfgGuardada, r.tipologia, faseActual(r), modalidadDe(r));
    var min = minutosEnMuelle(r);

    if (!meta) {
        return '<div class="muelle-meta sin-meta"><i class="ti ti-help-circle"></i> ' +
               formatDuration(min) + ' en muelle · sin meta (falta tipología)</div>';
    }

    var nivel = nivelContraMeta(min, meta);
    var icono = nivel === 'alta' ? 'ti-alert-triangle' : nivel === 'media' ? 'ti-clock-exclamation' : 'ti-clock-check';

    return '<div class="muelle-meta ' + nivel + '"><i class="ti ' + icono + '"></i> ' +
           formatDuration(min) + ' de ' + formatDuration(meta.meta) +
           (distingueModalidad(cfgGuardada) ? ' · ' + modalidadDe(r).toLowerCase() : '') +
           (nivel !== 'normal' ? ' · ' + formatDuration(min - meta.meta) + ' por encima' : '') +
           '</div>';
}

function pintarAlertaMuelle(enMuelle) {

    var banner = document.getElementById('alerta-muelle-banner');
    if (!banner) return;

    var fuera = enMuelleFueraDeMeta(enMuelle, cfgGuardada);

    if (!fuera.length) {
        banner.style.display = 'none';
        return;
    }

    banner.style.display = 'flex';
    document.getElementById('alerta-muelle-detalle').textContent =
        fuera.length + ' vehículo(s) pasaron la meta de su tipología en muelle: ' +
        fuera.map(function (r) {
            var p = prioridadDe(r, cfgGuardada);
            return r.placa + ' (' + formatDuration(p.minutos) + ' de ' + formatDuration(p.meta) +
                   ' · ' + formatDuration(p.exceso) + ' por encima)';
        }).join(', ');
}

/* El puesto en la fila ya no se decide con el mismo reloj para
   todos: el que está en muelle corre contra la meta de SU
   tipología y el que espera afuera contra el límite de patio. El
   badge muestra el reloj que efectivamente lo está midiendo. Ver
   prioridadDe() en eventos.js. */
function badgePrioridad(r, rank) {
    if (r.horaSalida) return '<span class="badge badge-salio">—</span>';
    var p = prioridadDe(r, cfgGuardada);
    var clase = p.nivel === 'alta' ? 'badge-amber' : (p.nivel === 'media' ? 'badge-descargue' : 'badge-en-patio');
    return '<span class="badge ' + clase + '" title="' + tituloPrioridad(p) + '">' +
           '<i class="ti ti-flag-3"></i> #' + rank + ' · ' + formatDuration(p.minutos) + '</span>';
}

/* Qué hay detrás del puesto en la fila: dónde está el vehículo,
   contra qué meta se le mide y cuánto lleva por encima. Sin esto
   el "#3" es un número que nadie puede verificar. */
function tituloPrioridad(p) {
    if (!p.referencia) return p.ubicacion + ' · sin meta configurada';
    return p.ubicacion + ' · ' + formatDuration(p.minutos) + ' de ' + formatDuration(p.referencia) +
        (p.estimada ? ' (promedio de la bodega — a este vehículo le falta la tipología)' : '') +
        (p.exceso ? ' · ' + formatDuration(p.exceso) + ' por encima' : '');
}


/* =========================================================
   COBROS

   La misma vista del supervisor de la bodega que cobra, completa.
   Las reglas de Firestore ya le abrían la colección `cobros` al
   administrador —lee, crea, corrige y es el único que puede
   borrar— pero no tenía dónde ejercerlo: si el supervisor de J4 se
   equivocaba en un cobro y ya no estaba, no había forma de
   arreglarlo desde la aplicación.

   El valor NO se digita: sale de la tarifa de la tipología, que se
   configura en la vista de Configuración de este mismo panel.
   Aquí solo se registra el soporte y por qué medio se pagó.

   Las tarifas se leen de `cfgTarifasGuardadas`, la copia publicada,
   nunca del borrador: cobrar contra un número que alguien tiene a
   medio escribir en el formulario de al lado sería cobrar de menos
   o de más sin que nadie lo note.
   ========================================================= */

var cobroVehiculo = null;
var cobroMedio = null;
var cobroSoporte = SOPORTE_POR_DEFECTO;

/* El desglose de la tarifa que le corresponde a un vehículo por su
   tipología: base, IVA, valor con IVA, tasa de INLOTRANS y lo que
   le queda a la cuadrilla. Cuál de esas cifras se cobra lo decide
   el soporte de pago, no esta función. */
function desgloseDe(rec) {
    return desglosarTarifa(cfgTarifasGuardadas, rec && rec.tipologia ? rec.tipologia : null);
}

function minutosAdentro(rec) {
    if (!rec || !rec.horaEntrada) return 0;
    var fin = rec.horaSalida ? new Date(rec.horaSalida) : new Date();
    return Math.max(0, (fin - new Date(rec.horaEntrada)) / 60000);
}

/* El ítem del menú y su contador. Se ocultan enteros donde no se
   cobra: un menú con una sección que nunca aplica invita a entrar a
   buscar algo que no está. */
function renderNavCobros() {

    var nav = document.getElementById('nav-cobros');
    var badge = document.getElementById('nav-cobros-badge');
    if (!nav) return;

    if (!bodegaCobraActual()) {
        nav.style.display = 'none';
        // Si estaba viendo Cobros y cambió a una bodega que no cobra,
        // se sale de la vista: quedaría una pantalla en blanco sin
        // ítem de menú con el que salir de ella.
        if (document.getElementById('view-cobros').classList.contains('active')) showView('dashboard');
        return;
    }

    nav.style.display = '';

    var n = pendientesDeCobro(registros, cobros).length;
    badge.textContent = n;
    badge.style.display = n ? '' : 'none';
}

function renderCobros() {

    if (!document.getElementById('view-cobros')) return;

    renderNavCobros();
    if (!bodegaCobraActual()) return;
    if (!document.getElementById('view-cobros').classList.contains('active')) return;

    renderResumenCaja();
    renderPendientesCobro();
    renderCobrosRegistrados();
}

/* La caja del día operativo en curso, no de toda la historia: lo
   que se cuadra al cerrar el turno. */
function renderResumenCaja() {

    var diaOp = todayOperativo(horaCorte());

    var deHoy = Object.keys(cobros)
        .map(function (k) { return cobros[k]; })
        .filter(function (c) { return diaOperativoDeCobro(c) === diaOp; });

    var r = resumenCaja(deHoy);

    document.getElementById('caja-total').textContent = fmtMoneda(r.total);
    document.getElementById('caja-efectivo').textContent = fmtMoneda(r.totalEfectivo);
    document.getElementById('caja-qr').textContent = fmtMoneda(r.totalQR);
    document.getElementById('caja-vehiculos').textContent = r.vehiculos;

    // El IVA que se liquidó de verdad: solo lo cobrado con factura.
    // Lo del recibo de caja menor se cobró sin impuesto y sumarlo
    // aquí inflaría la declaración.
    document.getElementById('caja-iva').textContent = fmtMoneda(r.totalIva);
    document.getElementById('caja-cuadrilla').textContent = fmtMoneda(r.totalCuadrilla);
    document.getElementById('caja-inlo').textContent = fmtMoneda(r.gananciaInlo);

    // El desglose por medio se dice siempre, incluso en ceros: es la
    // cifra que se compara contra el datáfono y el reporte del QR.
    document.getElementById('caja-desglose').innerHTML =
        r.porMedio.Efectivo.n + ' solo efectivo · ' +
        r.porMedio.QR.n + ' solo QR · ' +
        r.porMedio.Ambos.n + ' mixtos' +
        (r.facturados
            ? '<br>' + r.facturados + ' facturado(s) por ' + fmtMoneda(r.totalFacturado) + ' — no entra a la caja'
            : '');

    // Y por soporte, que es contra lo que se cuadra el talonario de
    // la caja menor al cerrar el turno.
    document.getElementById('caja-soportes').innerHTML =
        r.porSoporte['Recibo Caja Menor'].n + ' con recibo de caja menor (' +
        fmtMoneda(r.porSoporte['Recibo Caja Menor'].monto) + ') · ' +
        r.porSoporte['Factura'].n + ' con factura (' +
        fmtMoneda(r.porSoporte['Factura'].monto) + ')';
}

function diaOperativoDeCobro(c) {
    if (!c || !c.fecha) return null;
    var d = new Date(c.fecha);
    if (isNaN(d)) return null;
    d.setHours(d.getHours() - horaCorte());
    var off = d.getTimezoneOffset() * 60000;
    return new Date(d - off).toISOString().slice(0, 10);
}

function renderPendientesCobro() {

    var pendientes = pendientesDeCobro(registros, cobros);
    var tbody = document.getElementById('tabla-pendientes-body');

    tbody.innerHTML = pendientes.length
        ? pendientes.map(function (r) {
            // Se muestra el valor sin IVA porque es el que se cobra en
            // el caso corriente (recibo de caja menor). El otro va al
            // lado, para que quien pide factura no tenga que abrir el
            // modal para saber cuánto le va a tocar cobrar.
            var d = desgloseDe(r);
            return '<tr>' +
                '<td class="td-placa">' + escapar(r.placa) + '</td>' +
                '<td>' + escapar(r.conductor || '—') + '</td>' +
                '<td>' + escapar(r.tipologiaNombre || '—') + '</td>' +
                '<td class="monto' + (d.base ? '' : ' cero') + '">' +
                    (d.base
                        ? fmtMoneda(d.base) + '<span class="monto-alterno">' + fmtMoneda(d.conIva) + ' con factura</span>'
                        : 'sin tarifa') + '</td>' +
                '<td>' + fmtDt(r.horaEntrada) + '</td>' +
                '<td>' + formatDuration(minutosAdentro(r)) + '</td>' +
                '<td><button class="btn btn-sm btn-primary" data-cobrar="' + r.id + '"><i class="ti ti-cash"></i> Cobrar</button></td>' +
            '</tr>';
        }).join('')
        : '<tr><td colspan="7" class="empty-state">No hay vehículos pendientes de cobro.</td></tr>';

    // Los vehículos sin tipología no salen arriba porque no se les
    // puede cobrar todavía. Sin decirlo, una lista corta se leería
    // como "no falta nada", cuando lo que falta es otra cosa.
    var sinTipo = sinTipologia(registros);
    var aviso = document.getElementById('cobros-aviso-sin-tipologia');

    aviso.innerHTML = sinTipo.length
        ? '<div class="cobros-aviso"><i class="ti ti-alert-triangle"></i> Hay <strong>' + sinTipo.length +
          ' vehículo(s) adentro sin tipología asignada</strong> (' +
          sinTipo.slice(0, 5).map(function (r) { return escapar(r.placa); }).join(', ') +
          (sinTipo.length > 5 ? '…' : '') +
          '). No aparecen arriba porque sin tipología no hay tarifa que cobrar, y tampoco podrán salir. ' +
          'Se les asigna desde la ficha del vehículo o corrigiendo el registro.</div>'
        : '';
}

function renderCobrosRegistrados() {

    var diaOp = todayOperativo(horaCorte());

    var deHoy = Object.keys(cobros)
        .map(function (k) { return cobros[k]; })
        .filter(function (c) { return diaOperativoDeCobro(c) === diaOp; })
        .sort(function (a, b) { return new Date(b.fecha || 0) - new Date(a.fecha || 0); });

    var tbody = document.getElementById('tabla-cobros-body');

    tbody.innerHTML = deHoy.length
        ? deHoy.map(function (c) {
            // Corregir solo mientras el vehículo no haya salido:
            // después la caja del turno ya se cuadró contra estas
            // cifras.
            var rec = registros.find(function (r) { return r.id === c.vehiculoId; });
            var editable = rec && !rec.horaSalida;

            // El total de la fila es lo que entró a la caja. En un
            // cobro facturado al cliente los dos montos van en cero y
            // el valor se muestra desde `tarifa`, marcado, para que no
            // se lea como si el vehículo no hubiera pagado nada.
            var soporte = soporteDe(c);
            var entro = soporteEntraACaja(soporte);
            var total = entro ? (c.montoEfectivo || 0) + (c.montoQR || 0) : (c.tarifa || 0);

            return '<tr>' +
                '<td class="td-placa">' + escapar(c.placa) + '</td>' +
                '<td>' + escapar(c.tipologiaNombre || '—') + '</td>' +
                '<td><span class="badge-soporte">' + escapar(soporte) + '</span></td>' +
                '<td><span class="badge-medio ' + escapar(String(c.medio || '').toLowerCase()) + '">' + escapar(c.medio) + '</span></td>' +
                '<td class="monto' + (c.montoEfectivo ? '' : ' cero') + '">' + fmtMoneda(c.montoEfectivo) + '</td>' +
                '<td class="monto' + (c.montoQR ? '' : ' cero') + '">' + fmtMoneda(c.montoQR) + '</td>' +
                '<td class="monto' + (entro ? '' : ' cero') + '"><strong>' + fmtMoneda(total) + '</strong>' + (entro ? '' : ' <em>(facturado)</em>') + '</td>' +
                '<td>' + escapar(c.registradoPor || '—') + (c.editadoPor ? ' <em>(corregido)</em>' : '') + '</td>' +
                '<td>' + (editable
                    ? '<button class="btn btn-sm" data-cobrar="' + c.vehiculoId + '"><i class="ti ti-edit"></i> Corregir</button>'
                    : '') + '</td>' +
            '</tr>';
        }).join('')
        : '<tr><td colspan="9" class="empty-state">No se registró ningún cobro en el día operativo.</td></tr>';
}


/* ── Modal de cobro ── */

function openModalCobro(vehiculoId) {

    var rec = registros.find(function (r) { return r.id === vehiculoId; });
    if (!rec) return;

    var existente = cobros[vehiculoId] || null;

    cobroVehiculo = rec;
    cobroMedio = existente ? existente.medio : null;

    // Al corregir se retoma el soporte que se registró; en un cobro
    // nuevo se arranca en el recibo de caja menor, que es el caso
    // corriente. La factura es la excepción y hay que elegirla.
    cobroSoporte = existente ? soporteDe(existente) : SOPORTE_POR_DEFECTO;
    if (!soporteEntraACaja(cobroSoporte)) cobroMedio = null;

    document.getElementById('cobro-info').innerHTML =
        '<strong>' + escapar(rec.placa) + '</strong> — ' +
        escapar(rec.conductor || 'sin ' + rotulo('conductor').toLowerCase()) +
        ' · ' + escapar(rec.tipologiaNombre || 'sin tipología') +
        (existente ? ' <em>(corrigiendo un cobro ya registrado)</em>' : '');

    document.getElementById('cobro-efectivo').value =
        existente && existente.medio === 'Ambos' ? existente.montoEfectivo : '';

    pintarSoportes();
    pintarMediosPago();
    document.getElementById('cobro-errores').style.display = 'none';

    document.getElementById('modal-cobro').classList.add('open');
}

function pintarMediosPago() {
    document.querySelectorAll('#cobro-medios .medio-btn').forEach(function (btn) {
        btn.classList.toggle('activo', btn.dataset.medio === cobroMedio);
    });
}

/* El soporte elegido, cuánto se cobra por haberlo elegido y el
   desglose de esa cifra. Se muestra siempre —no solo cuando hay
   factura de por medio— porque la diferencia entre cobrar $38.000 y
   $45.220 es justamente lo que decide este botón, y equivocarse
   aquí es equivocarse en la caja. */
function pintarSoportes() {

    document.querySelectorAll('#cobro-soportes .soporte-btn').forEach(function (btn) {
        btn.classList.toggle('activo', btn.dataset.soporte === cobroSoporte);
    });

    var d = desgloseDe(cobroVehiculo);
    var total = tarifaDeSoporte(d, cobroSoporte);
    var conIva = cobroSoporte !== SOPORTE_POR_DEFECTO;

    document.getElementById('cobro-tarifa').textContent = fmtMoneda(total);
    document.getElementById('cobro-tarifa-label').textContent = conIva
        ? 'Se cobra el valor con IVA'
        : 'Se cobra el valor antes de IVA';

    document.getElementById('cobro-tarifa-detalle').innerHTML = d.base
        ? 'Base ' + fmtMoneda(d.base) +
          ' · IVA (' + d.ivaPorcentaje + '%) ' + fmtMoneda(d.iva) +
          (conIva ? '' : ' — no se liquida con recibo de caja menor') +
          '<br>Cuadrilla ' + fmtMoneda(d.cuadrilla) + ' · INLO ' + fmtMoneda(d.tasaInlo)
        : 'Esta tipología no tiene tarifa configurada.';

    // Facturado al cliente: no hay plata en portería, así que el
    // bloque de medios se oculta. Dejarlo visible pero inerte solo
    // invitaría a llenarlo para nada.
    var entraACaja = soporteEntraACaja(cobroSoporte);
    document.getElementById('cobro-medio-wrap').style.display = entraACaja ? '' : 'none';

    if (!entraACaja) {
        document.getElementById('cobro-split').style.display = 'none';
        return;
    }

    pintarSplitCobro();
}

/* El campo de reparto solo aparece con "Ambos": en los otros dos
   medios el monto es la tarifa completa y no hay nada que decidir. */
function pintarSplitCobro() {

    var split = document.getElementById('cobro-split');
    split.style.display = cobroMedio === 'Ambos' ? '' : 'none';

    if (cobroMedio !== 'Ambos') return;

    // El total a repartir depende del soporte: con factura hay que
    // repartir el valor con IVA, no la base.
    var total = tarifaDeSoporte(desgloseDe(cobroVehiculo), cobroSoporte);
    var efectivo = Number(document.getElementById('cobro-efectivo').value) || 0;
    var montos = repartir('Ambos', total, efectivo);

    document.getElementById('cobro-qr-calculado').textContent = fmtMoneda(montos.montoQR);
}

function seleccionarMedio(medio) {
    if (MEDIOS_PAGO.indexOf(medio) === -1) return;
    cobroMedio = medio;
    pintarMediosPago();
    pintarSplitCobro();
}

function seleccionarSoporte(soporte) {
    if (SOPORTES_PAGO.indexOf(soporte) === -1) return;
    cobroSoporte = soporte;
    if (!soporteEntraACaja(soporte)) cobroMedio = null;
    pintarSoportes();
    pintarMediosPago();
}

function pintarErroresCobro(errores) {
    var el = document.getElementById('cobro-errores');
    if (!errores.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = errores.map(function (e) { return escapar(e); }).join('<br>');
}

async function confirmarCobro() {

    if (!cobroVehiculo) return;

    var desglose = desgloseDe(cobroVehiculo);
    var datos = {
        soporte: cobroSoporte,
        medio: cobroMedio,
        montoEfectivo: Number(document.getElementById('cobro-efectivo').value) || 0,
        desglose: desglose,
        esCorreccion: !!cobros[cobroVehiculo.id]
    };

    var errores = validarCobro(datos, desglose);
    pintarErroresCobro(errores);
    if (errores.length) return;

    var btn = document.getElementById('btn-confirmar-cobro');
    btn.disabled = true;
    setSyncStatus('syncing');

    try {
        await registrarCobro(operacionActual, cobroVehiculo, datos, perfilActual.nombre);
        setSyncStatus('ok');
        toast('Cobro registrado para ' + cobroVehiculo.placa, 'green', 'ti-cash');
        closeModal('modal-cobro');
        cobroVehiculo = null;
        cobroMedio = null;
        cobroSoporte = SOPORTE_POR_DEFECTO;
    } catch (error) {
        console.error('Error al registrar el cobro:', error);
        setSyncStatus('error');
        pintarErroresCobro(['No se pudo guardar el cobro. Revisa la conexión e inténtalo de nuevo.']);
    } finally {
        btn.disabled = false;
    }
}

function wireCobros() {

    document.querySelectorAll('#cobro-medios .medio-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { seleccionarMedio(btn.dataset.medio); });
    });

    document.querySelectorAll('#cobro-soportes .soporte-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { seleccionarSoporte(btn.dataset.soporte); });
    });

    document.getElementById('cobro-efectivo').addEventListener('input', pintarSplitCobro);
    document.getElementById('btn-confirmar-cobro').addEventListener('click', confirmarCobro);
}


/* =========================================================
   CORREGIR LOS DATOS DEL VEHÍCULO

   Distinto del modal "Mover", que solo cambia la ubicación: aquí
   se corrige lo que se digitó mal en la entrada —placa, campos
   libres, tipo, canal, tipología, hora de entrada y cita— y cada
   cambio queda en el historial con el valor anterior y el nuevo.

   Existía solo en el supervisor de J4. Las reglas de Firestore
   nunca le impidieron al administrador escribir estos campos, así
   que lo que faltaba era la pantalla: una placa mal digitada en J3
   o en B9 no la podía corregir nadie.

   El avance, las autorizaciones, los cobros y las cancelaciones
   siguen por su propio flujo: cada uno tiene validaciones que este
   formulario no hace.
   ========================================================= */

var corregirVehiculoId = null;

/* Las horas se capturan en campos separados de hora y minuto, igual
   que en el resto del panel: los <input type="time"> nativos
   muestran am/pm o 24h según el sistema operativo, y eso no se
   puede forzar desde la página. */
function partirHora(iso) {
    if (!iso) return { fecha: '', h: '', m: '' };
    var partes = String(iso).split('T');
    var hm = (partes[1] || '').slice(0, 5).split(':');
    return { fecha: partes[0] || '', h: hm[0] || '', m: hm[1] || '' };
}

function openModalCorregir(id) {

    var rec = registros.find(function (r) { return r.id === id; });
    if (!rec) return;

    corregirVehiculoId = id;

    document.getElementById('corregir-info').innerHTML =
        '<strong>' + escapar(rec.placa) + '</strong> — ' + escapar(getDestino(rec));

    // Los dos campos libres se rotulan como los llame esta bodega:
    // en J4 se corrige el proveedor y el número de cita, no un
    // conductor con su cédula.
    document.getElementById('lbl-ed-conductor').textContent = rotulo('conductor');
    document.getElementById('lbl-ed-cedula').textContent = rotulo('cedula');

    document.getElementById('ed-placa').value = rec.placa || '';
    document.getElementById('ed-conductor').value = rec.conductor || '';
    document.getElementById('ed-cedula').value = rec.cedula || '';
    document.getElementById('ed-tipo').value = rec.tipo || 'Descargue';
    document.getElementById('ed-canal').value = canalDe(rec);
    document.getElementById('ed-obs').value = rec.obs || '';

    pintarSelectTipologiaCorreccion(rec.tipologia);

    /* Cómo vino la mercancía. El desplegable solo se ofrece donde la
       bodega lo distingue, pero se muestra igual si el registro ya
       trae una marcada: si no, apagar el interruptor dejaría ese dato
       sin forma de corregirse. */
    document.getElementById('ed-modalidad').value = rec.modalidad || '';
    document.getElementById('grupo-ed-modalidad').style.display =
        (distingueModalidad(cfgGuardada) || rec.modalidad) ? '' : 'none';

    var entrada = partirHora(rec.horaEntrada);
    document.getElementById('ed-fecha-entrada').value = entrada.fecha;
    document.getElementById('ed-hora-h').value = entrada.h;
    document.getElementById('ed-hora-m').value = entrada.m;

    document.getElementById('ed-programado').value = rec.programado ? 'Programado' : 'No programado';
    var cita = partirHora(rec.horaProgramacion);
    document.getElementById('ed-cita-h').value = cita.h;
    document.getElementById('ed-cita-m').value = cita.m;

    document.getElementById('corregir-errores').style.display = 'none';
    document.getElementById('modal-corregir').classList.add('open');
}

/* La lista sale de la configuración de la bodega. Se agrega la
   tipología que ya trae el vehículo aunque se haya borrado después:
   si no, abrir el modal y guardar sin tocar nada le cambiaría la
   tipología al vehículo en silencio. */
function pintarSelectTipologiaCorreccion(seleccionada) {

    var sel = document.getElementById('ed-tipologia');
    var lista = (cfgGuardada && cfgGuardada.tipologias) || [];

    var html = '<option value="">Sin tipología</option>';
    var encontrada = false;

    lista.forEach(function (t) {
        if (t.id === seleccionada) encontrada = true;
        html += '<option value="' + escapar(t.id) + '">' + escapar(t.nombre) + '</option>';
    });

    var rec = registros.find(function (r) { return r.id === corregirVehiculoId; });
    if (seleccionada && !encontrada) {
        html += '<option value="' + escapar(seleccionada) + '">' +
                escapar((rec && rec.tipologiaNombre) || 'Tipología retirada') + '</option>';
    }

    sel.innerHTML = html;
    sel.value = seleccionada || '';
}

async function confirmarCorreccion() {

    var rec = registros.find(function (r) { return r.id === corregirVehiculoId; });
    if (!rec) return;

    var errores = [];

    var placa = document.getElementById('ed-placa').value.trim().toUpperCase();
    if (!placa) errores.push('La placa no puede quedar vacía.');

    var conductor = document.getElementById('ed-conductor').value.trim();
    if (!conductor) errores.push(rotulo('conductor') + ' no puede quedar vacío.');

    var fechaEntrada = document.getElementById('ed-fecha-entrada').value;
    var hh = dosDigitos(document.getElementById('ed-hora-h').value, 23);
    var mm = dosDigitos(document.getElementById('ed-hora-m').value, 59);
    var horaEntrada = (fechaEntrada && hh !== null && mm !== null) ? fechaEntrada + 'T' + hh + ':' + mm : null;
    if (!horaEntrada) errores.push('La fecha y hora de entrada no son válidas (horas 0-23, minutos 0-59).');

    // Una salida anterior a la entrada dejaría el registro con
    // duraciones negativas y lo sacaría de todos los promedios.
    if (horaEntrada && rec.horaSalida && new Date(rec.horaSalida) < new Date(horaEntrada)) {
        errores.push('La hora de entrada no puede ser posterior a la de salida (' + fmtDt(rec.horaSalida) + ').');
    }

    var programado = document.getElementById('ed-programado').value === 'Programado';
    var citaHora = dosDigitos(document.getElementById('ed-cita-h').value, 23);
    var citaMin = dosDigitos(document.getElementById('ed-cita-m').value, 59);
    var hayCita = citaHora !== null && citaMin !== null;

    if (programado && !hayCita) errores.push('Un vehículo programado necesita hora de cita.');

    if (errores.length) {
        var caja = document.getElementById('corregir-errores');
        caja.innerHTML = errores.map(function (e) { return '<div>• ' + escapar(e) + '</div>'; }).join('');
        caja.style.display = '';
        return;
    }

    // La cita se guarda con la fecha de la ENTRADA, no la de hoy: es
    // contra la llegada que se mide el cumplimiento, y estamparle la
    // fecha del día en que se corrige daría un desfase de días.
    var tipologiaId = document.getElementById('ed-tipologia').value;
    var tipologia = buscarTipologia(cfgGuardada, tipologiaId);

    var cambios = {
        placa: placa,
        conductor: conductor,
        cedula: document.getElementById('ed-cedula').value.trim(),
        tipo: document.getElementById('ed-tipo').value,
        canal: document.getElementById('ed-canal').value,
        tipologia: tipologiaId,
        tipologiaNombre: tipologia ? tipologia.nombre : '',

        // Cadena vacía = sin marcar, que es lo que hace regir el
        // supuesto (arrumado). No se omite del objeto: corregirRegistro
        // compara campo por campo, y omitirlo haría imposible DESmarcar
        // una modalidad puesta por error.
        modalidad: document.getElementById('ed-modalidad').value,

        horaEntrada: horaEntrada,
        programado: programado,
        horaProgramacion: programado && hayCita ? horaEntrada.slice(0, 10) + 'T' + citaHora + ':' + citaMin : '',
        obs: document.getElementById('ed-obs').value.trim()
    };

    var btn = document.getElementById('btn-confirmar-correccion');
    btn.disabled = true;
    setSyncStatus('syncing');

    try {
        await corregirRegistro(rec.id, rec, cambios, perfilActual.nombre);
        setSyncStatus('ok');
        toast('Datos de ' + placa + ' corregidos', 'green', 'ti-edit');
        closeModal('modal-corregir');
        corregirVehiculoId = null;
    } catch (error) {
        console.error('Error al corregir el registro:', error);
        setSyncStatus('error');
        var cajaErr = document.getElementById('corregir-errores');
        cajaErr.innerHTML = '<div>• No se pudo guardar la corrección. Revisa tu conexión e inténtalo de nuevo.</div>';
        cajaErr.style.display = '';
    } finally {
        btn.disabled = false;
    }
}

function badgeEstado(r) {
    // Va antes que "Salió" porque un cancelado también trae hora de
    // salida: preguntando al revés se leerían todos como despachos
    // normales y la cancelación no se vería en la tabla.
    if (estaCancelado(r)) {
        var llego = r.cancelacion && r.cancelacion.llego;
        return '<span class="badge badge-cancelado" title="' + escapar((r.cancelacion && r.cancelacion.motivo) || '') + '">' +
               '<i class="ti ti-ban"></i> ' + (llego ? 'Cancelado' : 'No llegó') + '</span>';
    }
    if (r.horaSalida) return '<span class="badge badge-salio">Salió</span>';
    if (!requiereAvanceCompleto(r)) {
        return '<span class="badge badge-amber" title="Sin avance registrado — puede salir sin restricción de %"><i class="ti ti-alert-triangle"></i> Activo</span>';
    }
    return '<span class="badge badge-en-patio">Activo</span>';
}

/* El botón solo aparece donde hay algo que cancelar: en una bodega
   que maneja cancelaciones y sobre un vehículo que sigue adentro.
   Uno que ya salió no se cancela hacia atrás — su operación se
   hizo, y borrarla sería reescribir el turno. */
function botonCancelar(r) {
    if (!manejaCancelaciones() || r.horaSalida) return '';
    return '<button class="btn btn-sm btn-cancelar" data-cancelar="' + r.id +
           '" title="Marcar la operación como cancelada"><i class="ti ti-ban"></i></button>';
}

/* Cobrar desde la propia tabla de registros, sin ir a la vista de
   Cobros. Solo donde la bodega cobra y sobre un vehículo con
   tipología: sin ella no hay tarifa que aplicar. Se ofrece también
   sobre los ya cobrados, porque abre el mismo modal para corregir
   —que es justo lo que el administrador tiene que poder hacer y
   nadie más podía después de que el vehículo salía. */
function botonCobrar(r) {
    if (!bodegaCobraActual() || !r.tipologia) return '';
    var yaCobrado = !!cobros[r.id];
    return '<button class="btn btn-sm' + (yaCobrado ? '' : ' btn-primary') + '" data-cobrar="' + r.id +
           '" title="' + (yaCobrado ? 'Corregir el cobro registrado' : 'Registrar el cobro') +
           '"><i class="ti ti-cash"></i></button>';
}

function celdaMotivoPatio(r) {
    if (r.horaSalida || r.ubicacion !== 'Patio') return '<span style="color:var(--text-3);">—</span>';
    if (!r.obsUbicacion) return '<span style="color:var(--amber-600);cursor:pointer;text-decoration:underline;" data-observacion="' + r.id + '">Sin registrar</span>';
    var texto = r.obsUbicacion.length > 30 ? r.obsUbicacion.slice(0, 30) + '…' : r.obsUbicacion;
    return '<span title="' + r.obsUbicacion.replace(/"/g, '&quot;') + '">' + texto + '</span>';
}


/* =========================================================
   REGISTROS (tabla con filtros y búsqueda)
   ========================================================= */

function setFilter(f, btn) {
    currentFilter = f;
    document.querySelectorAll('.filter-pills .pill').forEach(function (p) { p.classList.remove('active'); });
    if (btn) btn.classList.add('active');
    renderRegistros();
}

function renderRegistros() {

    if (!document.getElementById('view-registros').classList.contains('active')) return;

    var search = (document.getElementById('search-input').value || '').toLowerCase().trim();

    // Parte del filtro global de canal del topbar, no de todo el
    // histórico: la tabla tiene que decir lo mismo que el tablero.
    var list = registrosFiltrados().slice();

    // Rango de fechas: por día operativo, igual que el resto del
    // panel. Cualquiera de los dos extremos puede ir vacío (solo
    // "desde" = de ahí en adelante; solo "hasta" = hasta ahí).
    var desde = document.getElementById('reg-desde').value;
    var hasta = document.getElementById('reg-hasta').value;
    if (desde || hasta) {
        list = list.filter(function (r) {
            var dia = getDiaOperativo(r, horaCorte());
            if (!dia) return false;
            if (desde && dia < desde) return false;
            if (hasta && dia > hasta) return false;
            return true;
        });
    }

    if (currentFilter === 'en_patio') list = list.filter(function (r) { return !r.horaSalida; });
    else if (currentFilter === 'salio') list = list.filter(function (r) { return !!r.horaSalida; });
    else if (currentFilter === 'Cargue' || currentFilter === 'Descargue') list = list.filter(function (r) { return r.tipo === currentFilter || r.tipo === 'Ambos'; });

    if (search) {
        list = list.filter(function (r) {
            return (r.placa || '').toLowerCase().indexOf(search) !== -1 ||
                (r.conductor || '').toLowerCase().indexOf(search) !== -1 ||
                (r.destino || '').toLowerCase().indexOf(search) !== -1;
        });
    }

    list = ordenarPorPrioridad(list, cfgGuardada);

    var tbody = document.getElementById('reg-table');

    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="17" class="empty-state">Sin registros con estos filtros' +
            ((desde || hasta) ? ' (rango de fechas aplicado)' : '') + '.</td></tr>';
        return;
    }

    var activeRank = 0;

    tbody.innerHTML = list.map(function (r) {
        if (!r.horaSalida) activeRank++;
        var dur = getLocationDurations(r);

        return '<tr>' +
            '<td>' + badgePrioridad(r, !r.horaSalida ? activeRank : '—') + '</td>' +
            '<td class="td-placa">' + r.placa + '</td>' +
            '<td>' + r.conductor + '</td>' +
            '<td>' + getDestino(r) + '</td>' +
            '<td><span class="badge badge-cargue">' + r.tipo + '</span></td>' +
            '<td>' + (r.canal || '—') + '</td>' +
            '<td>' + fmtDt(r.horaEntrada) + '</td>' +
            '<td>' + fmtDt(r.horaSalida) + '</td>' +
            '<td>' + badgeEstado(r) + '</td>' +
            '<td>' + (r.programado ? 'Sí' : 'No') + '</td>' +
            '<td>' + (r.programado && r.horaProgramacion ? fmtDt(r.horaProgramacion) : '—') + '</td>' +
            '<td>' + (r.servicioTipo || 'Normal') + '</td>' +
            '<td>' + formatDuration(dur.patio) + '</td>' +
            '<td>' + formatDuration(dur.muelle) + '</td>' +
            '<td>' + celdaMotivoPatio(r) + '</td>' +
            '<td>' + (r.operadorEntrada || '—') + '</td>' +
            '<td><div class="td-actions">' +
                (!r.horaSalida ? '<button class="btn btn-sm btn-success" data-salida="' + r.id + '"' + attrsBotonSalida(r) + '><i class="ti ti-logout"></i></button>' : '') +
                botonCancelar(r) +
                botonCobrar(r) +
                '<button class="btn btn-sm" data-editar="' + r.id + '" title="Mover de ubicación"><i class="ti ti-arrows-move"></i></button>' +
                '<button class="btn btn-sm" data-corregir="' + r.id + '" title="Corregir los datos del registro"><i class="ti ti-edit"></i></button>' +
                '<button class="btn btn-sm" data-observacion="' + r.id + '" title="Agregar observación"><i class="ti ti-message-plus"></i></button>' +
                '<button class="btn btn-sm" data-detalle="' + r.id + '"><i class="ti ti-info-circle"></i></button>' +
                '<button class="btn btn-sm btn-danger" data-eliminar="' + r.id + '"><i class="ti ti-trash"></i></button>' +
            '</div></td>' +
        '</tr>';
    }).join('');
}


/* =========================================================
   FORMULARIO DE ENTRADA
   ========================================================= */

function syncTipoUI() {
    var chkCargue = document.querySelector('input[name=tipo][value=Cargue]');
    var chkDescargue = document.querySelector('input[name=tipo][value=Descargue]');
    document.getElementById('rc-cargue').className = 'radio-card' + (chkCargue.checked ? ' sel-cargue' : '');
    document.getElementById('rc-descargue').className = 'radio-card' + (chkDescargue.checked ? ' sel-descargue' : '');
}

function getTipoSeleccionado() {
    var sel = Array.prototype.slice.call(document.querySelectorAll('input[name=tipo]:checked')).map(function (i) { return i.value; });
    if (sel.length === 2) return 'Ambos';
    return sel[0] || null;
}

function computeDestino(ubicacion, numeroMuelle, bahia) {
    if (ubicacion === 'Patio') return 'Patio';
    return 'Muelle ' + numeroMuelle + ' - Bahía ' + bahia;
}

function poblarSelectMuelles(selectEl, muelleActual) {

    if (!selectEl) return 0;

    var enMuelle = getRegistrosEnMuelle(registros);
    var lista = numerosMuelle();
    var ocupacion = getMuellesOcupacion(enMuelle, lista);
    var libres = getMuellesLibres(ocupacion, lista, muelleActual);
    var valorPrevio = selectEl.value;

    var html = '';
    libres.forEach(function (n) {
        var esActual = muelleActual != null && String(n) === String(muelleActual);
        html += '<option value="' + n + '">' + n + (esActual ? ' (actual)' : '') + '</option>';
    });
    selectEl.innerHTML = html || '<option value="" disabled selected>No hay muelles libres</option>';

    if (valorPrevio && selectEl.querySelector('option[value="' + valorPrevio + '"]')) {
        selectEl.value = valorPrevio;
    }

    return libres.length;
}

function cambiarUbicacion() {
    var ubicacion = document.getElementById('f-ubicacion').value;
    document.getElementById('muelle-options').style.display = ubicacion === 'Muelle' ? 'block' : 'none';
    if (ubicacion === 'Muelle') {
        var libres = poblarSelectMuelles(document.getElementById('f-numeroMuelle'), null);
        if (!libres) toast('No hay muelles libres en este momento', 'red', 'ti-alert-circle');
    }
}

function cambiarProgramado() {
    document.getElementById('programacion-wrapper').style.display =
        document.getElementById('f-programado').value === 'Programado' ? 'block' : 'none';
}

function cambiarServicioTipo() {
    var servicioTipo = document.getElementById('f-servicio-tipo').value;
    var wrapper = document.getElementById('servicio-empresa-wrapper');
    var empresaSelect = document.getElementById('f-servicio-empresa');
    var empresaText = document.getElementById('f-servicio-empresa-text');

    if (servicioTipo === 'Reciclaje') {
        wrapper.style.display = 'block'; empresaSelect.style.display = 'block'; empresaText.style.display = 'none'; empresaSelect.value = '';
    } else if (servicioTipo === 'Insumos') {
        wrapper.style.display = 'block'; empresaSelect.style.display = 'none'; empresaText.style.display = 'block'; empresaText.value = clienteActual();
    } else {
        wrapper.style.display = 'none'; empresaSelect.style.display = 'none'; empresaText.style.display = 'none';
    }
}

/*
    Desplegable de tipologías del formulario de entrada.

    Se llena con la configuración GUARDADA de la bodega activa, no
    con el borrador de la vista de configuración: un vehículo no
    puede quedar registrado con una tipología que todavía está a
    medio escribir en otra pestaña del panel.
*/
function renderSelectTipologiaEntrada() {

    var sel = document.getElementById('f-tipologia');
    var hint = document.getElementById('f-tipologia-hint');
    if (!sel) return;

    var seleccionActual = sel.value;

    if (!cfgGuardada) {
        sel.innerHTML = '<option value="">Cargando…</option>';
        sel.disabled = true;
        hint.textContent = '';
        hint.className = 'form-hint';
        return;
    }

    var lista = cfgGuardada.tipologias || [];

    if (!lista.length) {
        sel.innerHTML = '<option value="">Sin tipologías configuradas</option>';
        sel.disabled = true;
        hint.textContent = operacionActual + ' no tiene tipologías configuradas. Puedes registrar la entrada, ' +
            'pero el vehículo no podrá salir hasta que se le asigne una.';
        hint.className = 'form-hint aviso';
        return;
    }

    sel.disabled = false;
    sel.innerHTML = '<option value="">Selecciona la tipología</option>' +
        lista.map(function (t) {
            return '<option value="' + escapar(t.id) + '">' + escapar(t.nombre) + '</option>';
        }).join('');

    if (seleccionActual && buscarTipologia(cfgGuardada, seleccionActual)) {
        sel.value = seleccionActual;
    }

    hint.textContent = '';
    hint.className = 'form-hint';
}

/* =========================================================
   MODAL: TIPOLOGÍA OBLIGATORIA

   Bloquea el registro de entrada cuando la bodega ya tiene
   tipologías configuradas y no se eligió ninguna. Cancelar deja el
   formulario intacto para revisarlo, pero no registra.
   ========================================================= */

function abrirModalTipologia() {

    var sel = document.getElementById('m-tipologia');
    var lista = (cfgGuardada && cfgGuardada.tipologias) || [];

    sel.innerHTML = '<option value="">Selecciona la tipología</option>' +
        lista.map(function (t) {
            return '<option value="' + escapar(t.id) + '">' + escapar(t.nombre) + '</option>';
        }).join('');

    sel.value = '';
    document.getElementById('m-tipologia-error').textContent = '';

    document.getElementById('modal-tipologia').classList.add('open');
    sel.focus();
}

/*
    Pasa la elección al formulario y reintenta el registro llamando a
    registrarEntrada() otra vez, en vez de duplicar aquí el guardado:
    así la entrada sigue pasando por TODAS las validaciones, no solo
    por la que faltaba.
*/
function confirmarTipologia() {

    var sel = document.getElementById('m-tipologia');

    if (!sel.value) {
        document.getElementById('m-tipologia-error').textContent =
            'Elige una tipología para poder continuar.';
        return;
    }

    document.getElementById('f-tipologia').value = sel.value;
    closeModal('modal-tipologia');
    registrarEntrada();
}

function limpiarForm() {

    ['f-conductor', 'f-placa', 'f-ubicacion', 'f-numeroMuelle', 'f-cedula', 'f-obs', 'f-programado', 'f-servicio-tipo', 'f-tipologia']
        .forEach(function (id) { document.getElementById(id).value = ''; });

    limpiarHora('f-hora-programacion-h', 'f-hora-programacion-m');

    document.getElementById('f-servicio-empresa').value = '';
    document.getElementById('f-servicio-empresa-text').value = clienteActual();
    document.getElementById('programacion-wrapper').style.display = 'none';
    document.getElementById('servicio-empresa-wrapper').style.display = 'none';
    document.getElementById('f-canal').value = 'Otro';
    escribirFechaHora('f-fecha-ingreso', 'f-hora-h', 'f-hora-m', nowLocal());
    document.getElementById('muelle-options').style.display = 'none';

    document.querySelector('input[name=tipo][value=Cargue]').checked = true;
    document.querySelector('input[name=tipo][value=Descargue]').checked = false;

    syncTipoUI();
    cambiarServicioTipo();
}

async function registrarEntrada() {

    var conductor = document.getElementById('f-conductor').value.trim();
    var placa = document.getElementById('f-placa').value.trim().toUpperCase();
    var hora = leerFechaHora('f-fecha-ingreso', 'f-hora-h', 'f-hora-m');
    var ubicacion = document.getElementById('f-ubicacion').value;
    var numeroMuelle = document.getElementById('f-numeroMuelle').value;
    var canal = document.getElementById('f-canal').value;
    var tipo = getTipoSeleccionado();
    var programado = document.getElementById('f-programado').value;
    // La cita se captura solo como HH:MM, así que hay que darle una
    // fecha. Antes se usaba today(), la del día en que se digita: un
    // camión que llegó ayer 23:00 con cita 22:30, registrado hoy,
    // quedaba con la cita de HOY y el cumplimiento salía con 24h de
    // error. La fecha correcta es la de la entrada, que es contra la
    // que se compara. El cruce de medianoche (cita 23:50, llegada
    // 00:10) lo corrige clasificarOnTime() en eventos.js.
    var horaProgramacionInput = leerHora('f-hora-programacion-h', 'f-hora-programacion-m');
    var fechaIngreso = document.getElementById('f-fecha-ingreso').value || today();
    var horaProgramacion = horaProgramacionInput ? (fechaIngreso + 'T' + horaProgramacionInput) : '';
    var servicioTipo = document.getElementById('f-servicio-tipo').value;
    var servicioEmpresa = servicioTipo === 'Reciclaje' ? document.getElementById('f-servicio-empresa').value
        : servicioTipo === 'Insumos' ? document.getElementById('f-servicio-empresa-text').value : '';
    var cedula = document.getElementById('f-cedula').value.trim();
    var obs = document.getElementById('f-obs').value.trim();
    var tipologiaId = document.getElementById('f-tipologia').value;
    var tipologia = buscarTipologia(cfgGuardada, tipologiaId);

    if (!conductor) { toast('Ingresa ' + rotulo('conductor').toLowerCase(), 'red', 'ti-alert-circle'); return; }

    var errorConductor = errorDeFormato(conductor, formatoCampo(cfgGuardada, 'conductor'), rotulo('conductor'));
    if (errorConductor) { toast(errorConductor, 'red', 'ti-alert-circle'); return; }

    var errorCedula = errorDeFormato(cedula, formatoCampo(cfgGuardada, 'cedula'), rotulo('cedula'));
    if (errorCedula) { toast(errorCedula, 'red', 'ti-alert-circle'); return; }

    if (!placa) { toast('Ingresa la placa del vehículo', 'red', 'ti-alert-circle'); return; }
    if (horaFueraDeRango('f-hora-h', 'f-hora-m')) { toast('La hora de ingreso no es válida (horas 0-23, minutos 0-59)', 'red', 'ti-alert-circle'); return; }
    if (!hora) { toast('Selecciona la hora de ingreso', 'red', 'ti-alert-circle'); return; }
    if (!fechaDentroDeRango(hora)) { toast('La fecha de ingreso no puede ser futura ni anterior a ayer', 'red', 'ti-alert-circle'); return; }
    if (!ubicacion) { toast('Ingresa la ubicación', 'red', 'ti-alert-circle'); return; }
    if (ubicacion === 'Muelle' && !numeroMuelle) { toast('No hay muelles libres para asignar en este momento', 'red', 'ti-alert-circle'); return; }
    if (!tipo) { toast('Selecciona al menos un tipo de operación', 'red', 'ti-alert-circle'); return; }
    if (!programado) { toast('Selecciona si el vehículo está programado o no', 'red', 'ti-alert-circle'); return; }
    if (programado === 'Programado' && horaFueraDeRango('f-hora-programacion-h', 'f-hora-programacion-m')) { toast('La hora de programación no es válida (horas 0-23, minutos 0-59)', 'red', 'ti-alert-circle'); return; }
    if (programado === 'Programado' && !horaProgramacion) { toast('Ingresa hora de programación', 'red', 'ti-alert-circle'); return; }
    if (servicioTipo === 'Reciclaje' && !servicioEmpresa) { toast('Selecciona la empresa de reciclaje', 'red', 'ti-alert-circle'); return; }

    // Obligatoria solo si la bodega tiene tipologías configuradas: no
    // se puede exigir un dato que el formulario no tiene cómo ofrecer.
    //
    // Cuando falta, el registro se detiene y se abre el modal, que
    // trae el mismo desplegable para resolverlo sin perder lo ya
    // digitado.
    var hayTipologiasConfiguradas = !!(cfgGuardada && (cfgGuardada.tipologias || []).length);
    if (hayTipologiasConfiguradas && !tipologia) {
        abrirModalTipologia();
        return;
    }

    var activo = registros.find(function (r) { return r.placa === placa && !r.horaSalida; });
    if (activo) { toast('El vehículo ' + placa + ' ya está activo en ' + getDestino(activo), 'amber', 'ti-alert-triangle'); return; }

    var datos = {
        conductor: conductor, placa: placa, horaEntrada: hora,
        programado: programado, horaProgramacion: horaProgramacion,
        ubicacion: ubicacion, numeroMuelle: numeroMuelle, bahia: 'A', canal: canal,
        destino: computeDestino(ubicacion, numeroMuelle, 'A'),
        tipo: tipo, cedula: cedula, obs: obs,
        servicioTipo: servicioTipo || 'Normal', servicioEmpresa: servicioEmpresa,
        tipologia: tipologia ? tipologia.id : '',
        tipologiaNombre: tipologia ? tipologia.nombre : ''
    };

    setSyncStatus('syncing');

    try {
        await crearRegistro(operacionActual, datos, perfilActual.nombre);
        setSyncStatus('ok');
        toast('Vehículo ' + placa + ' registrado', 'green', 'ti-circle-check');
        limpiarForm();
        showView('dashboard');
    } catch (error) {
        setSyncStatus('error');
        toast('Error al guardar. Intenta de nuevo.', 'red', 'ti-x');
        console.error('Error al registrar entrada:', error);
    }
}


/* =========================================================
   MODAL: SALIDA
   ========================================================= */

/* El aviso de por qué un vehículo no puede salir, con el mínimo y el
   faltante. Misma alerta que ve el operario, construida sobre el mismo
   diagnosticoSalida() de shared/services/vehiculos.js: el admin tiene
   que ver exactamente lo que ve quien está en portería. Antes este
   panel tenía su propia copia de las frases CON EL UMBRAL ESCRITO A
   MANO, así que al subirlo de 75% a 95% habría seguido mostrando el
   número viejo. */
function attrsBotonSalida(rec) {
    var d = diagnosticoSalida(rec, cfgGuardada);
    if (d.puedeSalir) return '';
    return ' data-bloqueada="1" title="' + d.titulo +
        (d.faltante ? ' — faltan ' + d.faltante + '% para el ' + d.minimo + '%' : '') + '"';
}

function alertaSalida(rec) {

    var d = diagnosticoSalida(rec, cfgGuardada);
    if (d.nivel === 'ok') return '';

    var estilo = d.nivel === 'bloqueo' ? 'bloqueo' : (d.nivel === 'espera' ? 'espera' : 'aviso');
    var icono = d.nivel === 'bloqueo' ? 'ti-ban' : (d.nivel === 'espera' ? 'ti-hourglass-high' : 'ti-alert-triangle');

    var medidor = '';
    if (d.faltante) {
        medidor =
            '<div class="alerta-salida-medidor">' +
                '<div class="alerta-salida-bar">' +
                    '<div class="alerta-salida-bar-fill" style="width:' + d.porcentaje + '%"></div>' +
                    '<div class="alerta-salida-bar-min" style="left:' + d.minimo + '%"></div>' +
                '</div>' +
                '<div class="alerta-salida-cifras">' +
                    '<span>Actual: <strong>' + d.porcentaje + '%</strong></span>' +
                    '<span>Mínimo: <strong>' + d.minimo + '%</strong></span>' +
                    '<span class="alerta-salida-falta">Faltan: <strong>' + d.faltante + '%</strong></span>' +
                '</div>' +
            '</div>';
    }

    return '<div class="alerta-salida alerta-salida-' + estilo + '">' +
        '<div class="alerta-salida-top"><i class="ti ' + icono + '"></i>' + d.titulo + '</div>' +
        '<div class="alerta-salida-detalle">' + d.detalle + '</div>' +
        medidor +
        (d.accion ? '<div class="alerta-salida-accion"><i class="ti ti-arrow-narrow-right"></i> ' + d.accion + '</div>' : '') +
    '</div>';
}

/* Pinta la alerta y habilita o bloquea el botón de confirmar. Se llama
   al abrir el modal y otra vez en cada snapshot, para que si el avance
   sube o alguien autoriza la salida mientras el modal está abierto, el
   botón se destrabe solo. */
function pintarEstadoSalida(rec) {

    var d = diagnosticoSalida(rec, cfgGuardada);

    document.getElementById('modal-salida-info').innerHTML =
        '<strong>' + rec.placa + '</strong> — ' + rec.conductor + alertaSalida(rec);

    var btnConfirmar = document.getElementById('btn-confirmar-salida');
    btnConfirmar.disabled = !d.puedeSalir;
    btnConfirmar.title = d.puedeSalir ? '' : (d.accion || d.titulo);
    btnConfirmar.innerHTML = d.puedeSalir
        ? '<i class="ti ti-check"></i> Confirmar salida'
        : '<i class="ti ti-lock"></i> Salida bloqueada';
}

function refrescarModalSalida() {
    var modal = document.getElementById('modal-salida');
    if (!modal.classList.contains('open')) return;
    var rec = registros.find(function (r) { return r.id === selectedId; });
    if (rec) pintarEstadoSalida(rec);
}

function openModalSalida(id) {
    selectedId = id;
    var rec = registros.find(function (r) { return r.id === id; });
    if (!rec) return;

    pintarEstadoSalida(rec);
    escribirFechaHora('m-fecha-salida', 'm-hora-salida-h', 'm-hora-salida-m', nowLocal());
    document.getElementById('m-obs-salida').value = '';
    document.getElementById('modal-salida').classList.add('open');
}


/* =========================================================
   MODAL: OBSERVACIÓN RÁPIDA

   Anotar algo no debería obligar a pasar por "Mover": ese modal pide
   ubicación y canal, y para dejar una nota había que volver a
   confirmar unos valores que no se querían tocar. Aquí solo se
   escribe el texto; nada de la ubicación del vehículo se mueve.
   ========================================================= */

function openModalObservacion(id) {
    selectedId = id;
    var rec = registros.find(function (r) { return r.id === id; });
    if (!rec) return;

    document.getElementById('modal-observacion-info').innerHTML =
        '<strong>' + rec.placa + '</strong> — ' + rec.conductor + ' · ' + getDestino(rec) +
        (rec.obsUbicacion
            ? '<div style="margin-top:6px;font-size:12.5px;color:var(--text-3);">Última observación: ' + rec.obsUbicacion + '</div>'
            : '');

    // El textarea arranca vacío a propósito: se agrega una observación
    // nueva, no se edita la anterior (que queda en el historial).
    document.getElementById('o-texto').value = '';
    document.getElementById('modal-observacion').classList.add('open');
    document.getElementById('o-texto').focus();
}

async function confirmarObservacion() {
    var rec = registros.find(function (r) { return r.id === selectedId; });
    if (!rec) return;

    var texto = document.getElementById('o-texto').value.trim();
    if (!texto) { toast('Escribe la observación antes de guardar', 'red', 'ti-alert-circle'); return; }

    setSyncStatus('syncing');
    try {
        await agregarObservacion(rec.id, texto, perfilActual.nombre);
        setSyncStatus('ok');
        closeModal('modal-observacion');
        toast('Observación guardada', 'green', 'ti-message-check');
    } catch (error) {
        setSyncStatus('error');
        toast('No se pudo guardar la observación', 'red', 'ti-x');
        console.error(error);
    }
}

async function confirmarSalida() {
    var rec = registros.find(function (r) { return r.id === selectedId; });
    if (!rec) return;

    var diag = diagnosticoSalida(rec, cfgGuardada);
    if (!diag.puedeSalir) {
        toast(
            diag.faltante
                ? diag.titulo + ': faltan ' + diag.faltante + '% para el mínimo del ' + diag.minimo + '%'
                : diag.titulo,
            'red', 'ti-alert-circle'
        );
        return;
    }

    if (horaFueraDeRango('m-hora-salida-h', 'm-hora-salida-m')) { toast('La hora de salida no es válida (horas 0-23, minutos 0-59)', 'red', 'ti-alert-circle'); return; }
    var horaSalida = leerFechaHora('m-fecha-salida', 'm-hora-salida-h', 'm-hora-salida-m');
    if (!horaSalida) { toast('Selecciona la hora de salida', 'red', 'ti-alert-circle'); return; }

    var obsSalida = document.getElementById('m-obs-salida').value.trim();

    setSyncStatus('syncing');
    try {
        await registrarSalida(rec.id, horaSalida, obsSalida, perfilActual.nombre);
        setSyncStatus('ok');
        closeModal('modal-salida');
        toast('Salida registrada', 'green', 'ti-logout');
    } catch (error) {
        setSyncStatus('error');
        toast('Error al registrar la salida', 'red', 'ti-x');
        console.error(error);
    }
}


/* =========================================================
   MODAL: EDITAR UBICACIÓN / CANAL
   ========================================================= */

function openModalEditar(id) {
    selectedId = id;
    var rec = registros.find(function (r) { return r.id === id; });
    if (!rec) return;

    document.getElementById('modal-editar-info').innerHTML = '<strong>' + rec.placa + '</strong> — Ubicación actual: ' + getDestino(rec);
    document.getElementById('e-ubicacion').value = rec.ubicacion || 'Patio';
    document.getElementById('e-canal').value = canalDe(rec);
    document.getElementById('e-obs-ubicacion').value = '';
    cambiarUbicacionEdit();

    document.getElementById('tipo-operacion-actual').textContent = 'Actual: ' + rec.tipo;
    var btnAgregar = document.getElementById('btn-agregar-operacion');
    if (rec.tipo === 'Ambos') {
        btnAgregar.style.display = 'none';
    } else {
        var faltante = rec.tipo === 'Cargue' ? 'Descargue' : 'Cargue';
        btnAgregar.textContent = '+ Agregar ' + faltante + ' también';
        btnAgregar.style.display = 'inline-flex';
        btnAgregar.setAttribute('data-agregar-operacion', rec.id);
    }

    document.getElementById('modal-editar').classList.add('open');
}

async function confirmarAgregarOperacion(id) {
    var rec = registros.find(function (r) { return r.id === id; });
    if (!rec) return;

    var faltante = rec.tipo === 'Cargue' ? 'Descargue' : 'Cargue';
    if (!confirm('¿Confirmas que este vehículo también debe hacer ' + faltante + '?')) return;

    setSyncStatus('syncing');
    try {
        await agregarOperacionFaltante(rec.id, rec, perfilActual.nombre);
        setSyncStatus('ok');
        toast('Se agregó ' + faltante + ' a este vehículo', 'green', 'ti-check');
        openModalEditar(id);
    } catch (error) {
        setSyncStatus('error');
        toast('Error al actualizar el tipo de operación', 'red', 'ti-x');
        console.error(error);
    }
}

function cambiarUbicacionEdit() {
    var u = document.getElementById('e-ubicacion').value;
    var opts = document.getElementById('muelle-options-edit');
    opts.style.display = u === 'Muelle' ? 'block' : 'none';
    if (u === 'Muelle') {
        var rec = registros.find(function (r) { return r.id === selectedId; });
        poblarSelectMuelles(document.getElementById('e-numeroMuelle'), rec ? rec.numeroMuelle : null);
    }
}

async function confirmarEdicionUbicacion() {

    var rec = registros.find(function (r) { return r.id === selectedId; });
    if (!rec) return;

    var ubicacion = document.getElementById('e-ubicacion').value;
    var numeroMuelle = ubicacion === 'Muelle' ? document.getElementById('e-numeroMuelle').value : '';

    if (ubicacion === 'Muelle' && !numeroMuelle) { toast('No hay muelles libres para asignar', 'red', 'ti-alert-circle'); return; }

    var cambios = {
        ubicacion: ubicacion,
        numeroMuelle: numeroMuelle,
        bahia: 'A',
        destino: computeDestino(ubicacion, numeroMuelle, 'A'),
        ubicacionAnterior: getDestino(rec),
        canal: document.getElementById('e-canal').value,
        obsUbicacion: document.getElementById('e-obs-ubicacion').value.trim()
    };

    setSyncStatus('syncing');
    try {
        await actualizarUbicacion(rec.id, cambios, perfilActual.nombre);

        setSyncStatus('ok');
        closeModal('modal-editar');
        toast('Cambios guardados', 'green', 'ti-check');
    } catch (error) {
        setSyncStatus('error');
        toast('Error al guardar los cambios', 'red', 'ti-x');
        console.error(error);
    }
}


/* =========================================================
   VEHÍCULOS CANCELADOS

   Dos caminos al mismo estado, según el vehículo haya llegado o
   no. Los dos exigen motivo: una cifra de cancelados sin razones
   detrás no le sirve a nadie para corregir nada.

   Es una decisión de supervisor y administrador, nunca de
   portería — ver camposSoloDeSupervisor en firestore.rules.
   ========================================================= */

function openModalCancelar(id) {

    var rec = registros.find(function (r) { return r.id === id; });
    if (!rec) return;

    selectedId = id;

    document.getElementById('cancelar-info').innerHTML =
        '<strong>' + escapar(rec.placa) + '</strong> — ' + escapar(rec.conductor || 'sin registrar') +
        ' · ' + escapar(getDestino(rec));

    document.getElementById('cancelar-motivo').value = '';
    document.getElementById('cancelar-errores').style.display = 'none';

    document.getElementById('modal-cancelar').classList.add('open');
    document.getElementById('cancelar-motivo').focus();
}

async function confirmarCancelacion() {

    var rec = registros.find(function (r) { return r.id === selectedId; });
    if (!rec) return;

    var motivo = document.getElementById('cancelar-motivo').value.trim();
    var errores = document.getElementById('cancelar-errores');

    if (!motivo) {
        errores.style.display = '';
        errores.textContent = 'Escribe por qué se cancela. Queda en el historial del vehículo.';
        return;
    }

    setSyncStatus('syncing');
    try {
        await cancelarVehiculo(rec.id, { motivo: motivo }, perfilActual.nombre);
        setSyncStatus('ok');
        closeModal('modal-cancelar');
        toast('Operación cancelada', 'amber', 'ti-ban');
    } catch (error) {
        setSyncStatus('error');
        console.error('No se pudo cancelar:', error);
        errores.style.display = '';
        errores.textContent = 'No se pudo guardar la cancelación. Intenta de nuevo.';
    }
}

function openModalCitaCancelada() {

    document.getElementById('cita-placa').value = '';
    document.getElementById('cita-conductor').value = '';
    document.getElementById('cita-cedula').value = '';
    document.getElementById('cita-fecha').value = todayOperativo(horaCorte());
    document.getElementById('cita-hora').value = '';
    document.getElementById('cita-motivo').value = '';
    document.getElementById('cita-errores').style.display = 'none';

    document.getElementById('lbl-cita-conductor').textContent = rotulo('conductor');
    document.getElementById('lbl-cita-cedula').textContent = rotulo('cedula');

    document.getElementById('modal-cita-cancelada').classList.add('open');
    document.getElementById('cita-placa').focus();
}

async function confirmarCitaCancelada() {

    var errores = document.getElementById('cita-errores');
    var placa = document.getElementById('cita-placa').value.trim().toUpperCase();
    var motivo = document.getElementById('cita-motivo').value.trim();
    var fecha = document.getElementById('cita-fecha').value;
    var hora = document.getElementById('cita-hora').value;

    var fallos = [];
    if (!placa) fallos.push('Falta la placa del vehículo que no llegó.');
    if (!fecha) fallos.push('Falta la fecha de la cita.');
    if (!motivo) fallos.push('Escribe por qué se canceló la cita.');

    if (fallos.length) {
        errores.style.display = '';
        errores.innerHTML = fallos.map(function (f) { return escapar(f); }).join('<br>');
        return;
    }

    // La cancelación pertenece al día de la cita, no al día en que
    // alguien se acuerda de registrarla. Sin hora se ancla al
    // mediodía para que el corte del turno la deje en el día bueno.
    var horaProgramacion = fecha + 'T' + (hora || '12:00');

    setSyncStatus('syncing');
    try {
        await crearCitaCancelada(operacionActual, {
            placa: placa,
            conductor: document.getElementById('cita-conductor').value.trim(),
            cedula: document.getElementById('cita-cedula').value.trim(),
            horaProgramacion: horaProgramacion,
            motivo: motivo
        }, perfilActual.nombre);

        setSyncStatus('ok');
        closeModal('modal-cita-cancelada');
        toast('Cita cancelada registrada', 'amber', 'ti-calendar-x');
    } catch (error) {
        setSyncStatus('error');
        console.error('No se pudo registrar la cita cancelada:', error);
        errores.style.display = '';
        errores.textContent = 'No se pudo guardar. Intenta de nuevo.';
    }
}

/* El botón de registrar una cita cancelada solo existe donde la
   bodega maneja cancelaciones. */
function pintarBotonCitaCancelada() {
    var btn = document.getElementById('btn-cita-cancelada');
    if (btn) btn.style.display = manejaCancelaciones() ? '' : 'none';
}


/* =========================================================
   MODAL: DETALLE
   ========================================================= */

function openModalDetalle(id) {
    var rec = registros.find(function (r) { return r.id === id; });
    if (!rec) return;

    var hist = getHistorial(rec).slice().sort(function (a, b) { return new Date(b.fecha) - new Date(a.fecha); });

    var histHtml = !hist.length
        ? '<p style="color:var(--text-3); font-size:12.5px;">Sin historial.</p>'
        : hist.map(function (h) {
            return '<div class="historial-item">' +
                '<div class="historial-ico"><i class="ti ti-activity"></i></div>' +
                '<div class="historial-body">' +
                    '<div class="historial-top"><strong>' + tituloHistorial(h) + '</strong><span class="historial-fecha">' + fmtDt(h.fecha) + '</span></div>' +
                    '<div style="font-size:11px;color:var(--text-3);">' + (h.operador || '—') + '</div>' +
                    (h.texto ? '<div class="historial-texto">' + h.texto + '</div>' : '') +
                '</div></div>';
        }).join('');

    // La MISMA ficha que ven portería, supervisor y cliente. Este
    // panel se había quedado con una versión de ocho filas escrita
    // a mano: no mostraba tipología, canal, servicio, tiempos,
    // observaciones, cancelación ni cobro. Tres pantallas contando
    // cosas distintas del mismo vehículo es exactamente lo que la
    // ficha compartida existe para evitar.
    document.getElementById('modal-detalle-body').innerHTML =
        fichaVehiculo(rec, {
            etiquetas: etiquetasCampos(),
            distingueModalidad: distingueModalidad(cfgGuardada),
            mostrarOperarios: true,

            // El administrador puede leer los cobros completos —las
            // reglas se los abren— así que ve el desglose, y el
            // estado del pago cuando todavía no se ha cobrado.
            cobro: bodegaCobraActual() ? cobros[rec.id] || null : null,
            mostrarPago: bodegaCobraActual()
        }) +
        bloqueAutorizacion(rec) +
        '<div class="detail-section-title">Historial</div>' + histHtml;

    document.getElementById('modal-detalle').classList.add('open');
}


/* =========================================================
   ELIMINAR REGISTRO
   ========================================================= */

async function eliminarRegistro(id) {
    if (!confirm('¿Eliminar este registro? Esta acción no se puede deshacer.')) return;

    try {
        await eliminarRegistroFirestore(id);
        toast('Registro eliminado', 'amber', 'ti-trash');
    } catch (error) {
        toast('Error al eliminar', 'red', 'ti-x');
        console.error(error);
    }
}


/* =========================================================
   MODALES: cerrar
   ========================================================= */

function closeModal(id) {
    document.getElementById(id).classList.remove('open');
}


/* =========================================================
   EXPORTAR
   ========================================================= */

function getStateLabel(r) {
    return r.horaSalida ? 'Salió' : (r.ubicacion === 'Muelle' ? 'En muelle' : 'En patio');
}

function exportarTodos() {
    var ok = exportarExcel(registros, getStateLabel, 'inlotrans_' + operacionActual + '_' + today() + '.xlsx', 'Registros ' + operacionActual, etiquetasCampos());
    if (!ok) toast('No hay registros para exportar', 'amber', 'ti-alert-circle');
}

function exportarHoy() {
    var hoy = today();
    var deHoy = registros.filter(function (r) { return (r.fecha || (r.horaEntrada || '').slice(0, 10)) === hoy; });
    var ok = exportarExcel(deHoy, getStateLabel, 'inlotrans_' + operacionActual + '_hoy_' + hoy + '.xlsx', 'Hoy', etiquetasCampos());
    if (!ok) toast('No hay registros de hoy para exportar', 'amber', 'ti-alert-circle');
}

/* Exportar un rango de fechas, como ya podían supervisor y cliente.
   Aquí solo había "todos" y "hoy": para sacar el mes pasado tocaba
   bajar el histórico completo y recortarlo en Excel.

   El rango se aplica por DÍA OPERATIVO y no por fecha de calendario,
   igual que la tabla de Registros: un vehículo que entró a las 2am
   pertenece al turno del día anterior, y cortarlo por medianoche lo
   dejaría en el archivo equivocado. */
function exportarRango() {

    var desde = document.getElementById('exp-desde').value;
    var hasta = document.getElementById('exp-hasta').value;

    if (!desde && !hasta) {
        toast('Elige al menos una de las dos fechas', 'amber', 'ti-alert-circle');
        return;
    }

    if (desde && hasta && desde > hasta) {
        toast('La fecha "desde" es posterior a la de "hasta"', 'amber', 'ti-alert-circle');
        return;
    }

    var lista = registros.filter(function (r) {
        var dia = getDiaOperativo(r, horaCorte());
        if (!dia) return false;
        if (desde && dia < desde) return false;
        if (hasta && dia > hasta) return false;
        return true;
    });

    var nombre = 'inlotrans_' + operacionActual + '_' + (desde || 'inicio') + '_a_' + (hasta || 'hoy') + '.xlsx';
    var ok = exportarExcel(lista, getStateLabel, nombre, 'Rango', etiquetasCampos());
    if (!ok) toast('No hay registros en ese rango', 'amber', 'ti-alert-circle');
}


/* =========================================================
   AVANCE DE CARGUE/DESCARGUE  (capacidad de supervisor)

   Mismas reglas de negocio que en supervisor.js: el descargue
   debe llegar al 100% sin excepción; el cargue puede salir desde
   MINIMO_CARGUE_ANTICIPADO pero solo con autorización motivada.
   El admin puede hacer las dos cosas sin cambiar de panel.
   ========================================================= */

function escapar(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getAvanceTipoEfectivo(r) {
    if (r.avanceTipo) return r.avanceTipo;
    if (r.tipo === 'Cargue' || r.tipo === 'Descargue') return r.tipo;
    return null;
}

function renderAvance(r) {

    // Vehículos anteriores a la regla de avance: no tienen el campo
    // y por eso hoy pueden salir sin restricción de %. Se avisa y se
    // ofrece fijarles el avance para que la regla empiece a aplicar.
    if (!requiereAvanceCompleto(r)) {
        var botones = (r.tipo === 'Cargue' || r.tipo === 'Descargue')
            ? '<button class="btn btn-sm btn-primary" data-avance-tipo="' + r.id + ':' + r.tipo + '">Fijar avance (' + r.tipo + ')</button>'
            : '<button class="btn btn-sm btn-primary" data-avance-tipo="' + r.id + ':Cargue">Cargue</button>' +
              '<button class="btn btn-sm btn-primary" data-avance-tipo="' + r.id + ':Descargue">Descargue</button>';
        return '<div class="avance-box">' +
            '<div style="font-size:11.5px;color:var(--amber-600);"><i class="ti ti-alert-triangle"></i> Sin avance registrado — puede salir sin restricción de %.</div>' +
            '<div class="avance-selector-btns" style="margin-top:6px;">' + botones + '</div>' +
            '</div>';
    }

    var avanceTipo = getAvanceTipoEfectivo(r);

    if (!avanceTipo) {
        return '<div class="avance-box">' +
            '<span class="avance-label">¿Cargue o descargue?</span>' +
            '<div class="avance-selector-btns">' +
                '<button class="btn btn-sm btn-primary" data-avance-tipo="' + r.id + ':Cargue">Cargue</button>' +
                '<button class="btn btn-sm btn-primary" data-avance-tipo="' + r.id + ':Descargue">Descargue</button>' +
            '</div></div>';
    }

    var pct = r.avancePorcentaje || 0;
    var claseBadge = avanceTipo === 'Cargue' ? 'badge-cargue' : 'badge-descargue';
    var deshabilitado = pct >= 100 ? 'disabled' : '';

    var aviso = '';
    if (puedeAutorizarSalidaAnticipada(r, cfgGuardada) && !(r.autorizacionSalida && r.autorizacionSalida.motivo)) {
        aviso = '<div style="margin-top:4px;font-size:11px;color:var(--amber-600);"><i class="ti ti-alert-triangle"></i> Requiere autorización para salir' +
                ' <button class="btn btn-sm" data-autorizar="' + r.id + '" style="margin-left:4px;">Autorizar</button></div>';
    } else if (r.autorizacionSalida && r.autorizacionSalida.motivo && pct < 100) {
        aviso = '<div style="margin-top:4px;font-size:11px;color:var(--green-600);"><i class="ti ti-shield-check"></i> Salida anticipada autorizada</div>';
    }

    return '<div class="avance-box">' +
        '<div class="avance-info">' +
            '<span class="badge ' + claseBadge + '">' + avanceTipo + '</span>' +
            '<span class="avance-pct">' + pct + '%</span>' +
        '</div>' +
        '<div class="avance-bar"><div class="avance-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="avance-btns">' +
            '<button class="btn btn-sm" data-avance-add="' + r.id + ':1" ' + deshabilitado + '>+1%</button>' +
            '<button class="btn btn-sm" data-avance-add="' + r.id + ':5" ' + deshabilitado + '>+5%</button>' +
            '<button class="btn btn-sm" data-avance-add="' + r.id + ':10" ' + deshabilitado + '>+10%</button>' +
        '</div>' + aviso +
        '</div>';
}

// Constancia de la autorización de salida anticipada, si la hubo.
function bloqueAutorizacion(r) {
    if (!r.autorizacionSalida || !r.autorizacionSalida.motivo) return '';
    var a = r.autorizacionSalida;
    return '<div class="detail-section-title">Autorización de salida anticipada</div>' +
        '<p style="font-size:12.5px;">Autorizada por <strong>' + escapar(a.autorizadoPor) + '</strong> el ' + fmtDt(a.fecha) +
        ', con ' + (a.porcentajeAlAutorizar || 0) + '% de avance.<br>Motivo: ' + escapar(a.motivo) + '</p>';
}

async function seleccionarAvanceTipo(id, tipo) {
    setSyncStatus('syncing');
    try {
        await actualizarAvance(id, { avanceTipo: tipo, porcentaje: 0 }, perfilActual.nombre);
        setSyncStatus('ok');
        toast('Avance fijado en ' + tipo + ' 0%', 'green', 'ti-check');
    } catch (error) {
        setSyncStatus('error');
        toast('No se pudo guardar el tipo de avance', 'red', 'ti-x');
        console.error(error);
    }
}

async function incrementarAvance(id, delta) {
    var rec = registros.find(function (r) { return r.id === id; });
    if (!rec) return;

    var avanceTipo = getAvanceTipoEfectivo(rec);
    if (!avanceTipo) return;

    var actual = rec.avancePorcentaje || 0;
    if (actual >= 100) return;

    var nuevoPct = Math.min(100, actual + delta);

    setSyncStatus('syncing');
    try {
        await actualizarAvance(id, { avanceTipo: avanceTipo, porcentaje: nuevoPct }, perfilActual.nombre);

        // "Ambos": al completar el descargue pasa solo a cargue,
        // retomando el % que traía pendiente si lo había.
        if (rec.tipo === 'Ambos' && avanceTipo === 'Descargue' && nuevoPct >= 100) {
            await avanzarAFaseCargue(id, { porcentajeInicial: rec.avanceCarguePendiente || 0 }, perfilActual.nombre);
        }
        setSyncStatus('ok');
    } catch (error) {
        setSyncStatus('error');
        toast('No se pudo guardar el avance', 'red', 'ti-x');
        console.error(error);
    }
}

async function autorizarSalida(id) {
    var rec = registros.find(function (r) { return r.id === id; });
    if (!rec) return;

    var motivo = prompt('Motivo de la salida anticipada (queda en el historial del vehículo):', '');
    if (motivo === null) return;
    motivo = motivo.trim();
    if (!motivo) { toast('Debes explicar el motivo', 'red', 'ti-alert-circle'); return; }

    setSyncStatus('syncing');
    try {
        await autorizarSalidaAnticipada(id, { motivo: motivo, porcentaje: rec.avancePorcentaje || 0 }, perfilActual.nombre);
        setSyncStatus('ok');
        toast('Salida anticipada autorizada', 'green', 'ti-shield-check');
    } catch (error) {
        setSyncStatus('error');
        toast('Error al autorizar la salida', 'red', 'ti-x');
        console.error(error);
    }
}


/* =========================================================
   SELECTOR DE OPERACIÓN (J3 / J4 / B9)

   Cambia la bodega que se está administrando: corta la
   suscripción anterior, limpia lo que quedaba en pantalla y
   vuelve a suscribirse a la nueva. Se recuerda en localStorage.
   ========================================================= */

function cambiarOperacion(nueva) {
    if (!OPERACIONES[nueva] || nueva === operacionActual) return;

    // La configuración es por bodega: cambiar de bodega con un
    // borrador a medio editar lo perdería sin avisar.
    if (cfgHayCambios() &&
        !confirm('Tienes cambios sin guardar en la configuración de ' + operacionActual + '. ¿Cambiar de bodega y descartarlos?')) {
        document.getElementById('selector-operacion').value = operacionActual;
        return;
    }

    operacionActual = nueva;
    localStorage.setItem(STORAGE_OPERACION, nueva);

    // El color primero, antes de vaciar y repintar: es la señal de que
    // se cambió de bodega, y llega junto con la pantalla en blanco en
    // vez de un instante después.
    aplicarColorDeBodega(nueva);

    if (unsubscribeRegistros) { unsubscribeRegistros(); unsubscribeRegistros = null; }
    if (unsubscribeCobros) { unsubscribeCobros(); unsubscribeCobros = null; }

    registros = [];
    cobros = {};
    selectedId = null;
    cfgBorrador = null;
    cfgGuardada = null;
    cfgTarifas = tarifasPorDefecto();
    cfgTarifasGuardadas = tarifasPorDefecto();
    renderTodo();

    pintarEtiquetasOperacion();
    suscribir();
    cargarConfiguracion();

    toast('Viendo operación ' + nueva + ' (' + clienteActual() + ')', 'blue', 'ti-building-warehouse');
}

function pintarEtiquetasOperacion() {
    document.getElementById('op-operacion').textContent = operacionActual + ' · ' + clienteActual();
    var lista = numerosMuelle();
    document.getElementById('muelles-titulo').textContent = lista.length
        ? 'Muelles (' + lista[0] + ' a ' + lista[lista.length - 1] + ')'
        : 'Muelles';

    var selector = document.getElementById('selector-operacion');
    selector.value = operacionActual;

    // El nombre del cliente del desplegable se actualiza al de la
    // configuración. Solo el de la bodega abierta: de las otras dos
    // no se ha leído la configuración, y poner un nombre inventado
    // sería peor que dejar el de partida.
    var opcion = selector.querySelector('option[value="' + operacionActual + '"]');
    if (opcion) opcion.textContent = operacionActual + ' · ' + clienteActual();

    // El formulario de entrada muestra el cliente de la bodega activa
    cambiarServicioTipo();
}

function suscribir() {
    unsubscribeRegistros = suscribirseARegistros(operacionActual, function (data, error) {
        if (error) { setSyncStatus('error'); return; }
        setSyncStatus('ok');
        registros = data;
        renderTodo();
        refrescarModalSalida();
        if (document.getElementById('muelle-options').style.display !== 'none') {
            poblarSelectMuelles(document.getElementById('f-numeroMuelle'), null);
        }
    });

    /* Los cobros alimentan el bloque de caja de las estadísticas.
       El administrador es el otro rol que puede leerlos —las reglas
       se los abren completos— y sin esta suscripción sus tarjetas
       de caja saldrían en cero, que se leería como "no se cobró
       nada" en vez de "nadie preguntó".

       En las bodegas que no cobran la consulta simplemente no
       devuelve documentos: no hay que preguntar primero si cobra. */
    unsubscribeCobros = suscribirseACobros(operacionActual, function (mapa, error) {
        if (error) {
            console.error('No se pudieron leer los cobros de ' + operacionActual + ':', error);
            return;
        }
        cobros = mapa || {};
        renderTodo();
    });
}


/* =========================================================
   ESTADÍSTICAS

   El render completo vive en shared/services/estadisticas.js, el
   mismo que usan supervisor y cliente: las tres vistas muestran
   exactamente las mismas cifras y no pueden divergir. Aquí solo
   queda lo propio de este panel — qué periodo está viendo el
   usuario y qué registros entran.

   El HTML de admin trae TODOS los contenedores (los del supervisor
   y los del cliente), porque el administrador tiene que ver todo lo
   que ve cualquier rol. Las funciones del módulo se saltan en
   silencio los contenedores que un panel no traiga.
   ========================================================= */

var estadPeriodoActual = 'todo';
var rangoRecortado = 0;
var MAX_DIAS_RANGO = 366;

function iniciarPeriodoEstadisticas() {
    document.querySelectorAll('#view-estadisticas .filter-pills .pill').forEach(function (btn) {
        btn.addEventListener('click', function () { setPeriodoEstadisticas(btn.dataset.periodo, btn); });
    });
    document.getElementById('estad-aplicar-rango').addEventListener('click', renderEstadisticas);
    // El mismo filtro global del topbar, visto desde aquí: escribe la
    // misma variable y sincroniza el otro desplegable.
    document.getElementById('ontime-canal').addEventListener('change', function (e) {
        canalFiltro = e.target.value;
        sincronizarSelectoresCanal();
        renderTodo();
    });
}

function setPeriodoEstadisticas(periodo, btn) {

    estadPeriodoActual = periodo;
    document.querySelectorAll('#view-estadisticas .filter-pills .pill').forEach(function (el) { el.classList.remove('active'); });
    if (btn) btn.classList.add('active');

    var custom = document.getElementById('estad-rango-custom');
    if (periodo === 'personalizado') {
        custom.style.display = 'flex';
        if (!document.getElementById('estad-hasta').value) {
            var hoyOp = todayOperativo(horaCorte());
            document.getElementById('estad-hasta').value = hoyOp;
            document.getElementById('estad-desde').value = hoyOp;
        }
        return; // esperar a que el usuario pulse "Aplicar"
    }

    custom.style.display = 'none';
    renderEstadisticas();
}

function getDiasOperativosDelPeriodo() {

    var hoyOp = todayOperativo(horaCorte());

    if (estadPeriodoActual === 'personalizado') {
        var desde = document.getElementById('estad-desde').value;
        var hasta = document.getElementById('estad-hasta').value;
        return buildDayRange(desde || hoyOp, hasta || hoyOp);
    }

    if (estadPeriodoActual === 'todo') {
        var dias = {};
        registros.forEach(function (r) {
            var d = getDiaOperativo(r, horaCorte());
            if (d) dias[d] = true;
        });
        var lista = Object.keys(dias);
        if (!lista.length) lista.push(hoyOp);
        rangoRecortado = 0;
        return lista.sort();
    }

    var nDias = estadPeriodoActual === '3dias' ? 3
        : estadPeriodoActual === 'semana' ? 7
        : estadPeriodoActual === 'mes' ? 30 : 1;

    var salida = [];
    rangoRecortado = 0;
    for (var i = nDias - 1; i >= 0; i--) salida.push(sumarDias(hoyOp, -i));
    return salida;
}

/* El rango personalizado tiene tope (un año) porque cada día es un
   punto en las gráficas, pero cuando recorta lo dice en vez de
   dejar al usuario creyendo que vio todo lo que pidió. */
function buildDayRange(desde, hasta) {

    var dias = [];
    var cur = desde;
    while (cur <= hasta && dias.length < MAX_DIAS_RANGO) {
        dias.push(cur);
        cur = sumarDias(cur, 1);
    }

    var pedidos = Math.round(
        (new Date(hasta + 'T12:00:00Z') - new Date(desde + 'T12:00:00Z')) / 86400000
    ) + 1;
    rangoRecortado = Math.max(0, pedidos - dias.length);

    return dias.length ? dias : [todayOperativo(horaCorte())];
}

function pintarAvisoRango() {
    var el = document.getElementById('estad-aviso-rango');
    if (!el) return;
    if (estadPeriodoActual !== 'personalizado' || !rangoRecortado) {
        el.style.display = 'none';
        return;
    }
    el.style.display = '';
    el.textContent = 'El rango pedido es más largo de lo que este panel puede graficar: se están ' +
        'mostrando los primeros ' + MAX_DIAS_RANGO + ' días y quedaron ' + rangoRecortado + ' por fuera.';
}

function renderEstadisticas() {

    if (!document.getElementById('view-estadisticas').classList.contains('active')) return;

    var dias = getDiasOperativosDelPeriodo();
    pintarAvisoRango();
    var diasSet = {};
    dias.forEach(function (d) { diasSet[d] = true; });

    // El filtro de canal recorta toda la vista, no solo la caja de
    // cumplimiento de cita: así no hay dos universos distintos en la
    // misma pantalla. Es el mismo del topbar — ver registrosFiltrados().
    var base = registrosFiltrados();

    renderPanelEstadisticas({
        recs: base.filter(function (r) { return diasSet[getDiaOperativo(r, horaCorte())]; }),
        base: base,
        todos: registros,
        dias: dias,
        horaCorte: horaCorte(),

        // La meta de patio sale de la bodega que se esté mirando,
        // no de un número fijo: es el mismo límite que el
        // administrador acaba de configurar más abajo en esta
        // misma pantalla.
        config: cfgGuardada,
        cobros: cobros
    });
}


/* =========================================================
   CONFIGURACIÓN DE LA BODEGA

   Los números que gobiernan la operación (límite de patio,
   capacidad, tipologías con sus tarifas y tiempos) viven en
   shared/services/config.js, un documento por bodega. Esta vista
   es el único sitio donde se editan: las reglas de Firestore solo
   dejan escribir ahí al administrador.

   El formulario trabaja sobre un BORRADOR en memoria y no escribe
   nada hasta que se pulsa Guardar. Es a propósito: la
   configuración se lee en vivo desde los paneles de portería, y
   guardar en cada tecla significaría que el operario ve aparecer
   media tipología mientras alguien la escribe.

   Las tarifas se cargan y se guardan por separado porque viven en
   una subcolección restringida (ver el encabezado de config.js).
   ========================================================= */

var cfgBorrador = null;          // configuración en edición
var cfgTarifas = tarifasPorDefecto();   // { ivaPorcentaje, valores } en edición
var cfgGuardada = null;          // lo último leído de Firestore
var cfgTarifasGuardadas = tarifasPorDefecto();
var cfgCargando = false;

/*
    Solo la parte editable. `actualizadoEn` viene de Firestore como
    Timestamp y `actualizadoPor` lo escribe el servidor: compararlos
    haría que el formulario se declarara "sucio" por metadatos que
    el administrador nunca tocó, y saldría un aviso de cambios sin
    guardar al cambiar de bodega sin haber escrito nada.
*/
function cfgEditable(config) {
    if (!config) return null;
    return {
        cliente: config.cliente,
        muelles: config.muelles,
        horaCorte: config.horaCorte,
        campos: config.campos,
        manejaCancelaciones: config.manejaCancelaciones,
        cobraVehiculos: config.cobraVehiculos,
        limitePatio: config.limitePatio,
        minimoCargue: config.minimoCargue,
        minimoDescargue: config.minimoDescargue,
        capacidadDiaria: config.capacidadDiaria,
        posicionesTotales: config.posicionesTotales,
        horaReporteOcupacion: config.horaReporteOcupacion,
        pesosNivelServicio: config.pesosNivelServicio,
        tipologias: config.tipologias
    };
}

function cfgHayCambios() {
    if (!cfgBorrador || !cfgGuardada) return false;
    return JSON.stringify(cfgEditable(cfgBorrador)) !== JSON.stringify(cfgEditable(cfgGuardada)) ||
           JSON.stringify(cfgTarifas) !== JSON.stringify(cfgTarifasGuardadas);
}

async function cargarConfiguracion() {

    if (cfgCargando) return;
    cfgCargando = true;

    try {
        var config = await obtenerConfig(operacionActual);
        var tarifas = await obtenerTarifas(operacionActual);

        cfgGuardada = config;
        cfgTarifasGuardadas = tarifas.tarifas;

        // Copias independientes: editar el borrador no debe tocar
        // la referencia contra la que se comparan los cambios.
        cfgBorrador = JSON.parse(JSON.stringify(config));
        cfgTarifas = JSON.parse(JSON.stringify(tarifas.tarifas));

        pintarErrorCarga(null);
        renderConfiguracion();

        // El formulario de entrada vive en otra vista pero se surte
        // de la misma configuración: si aquí se acaba de guardar una
        // tipología nueva, allá tiene que aparecer.
        renderSelectTipologiaEntrada();

        // El nombre del cliente, el número de muelles y la hora de
        // corte ahora salen de esta configuración, así que el panel
        // entero se repinta: el tablero de muelles puede tener otro
        // tamaño y los promedios del día, otro corte.
        pintarEtiquetasOperacion();
        pintarEtiquetasCampos();
        pintarBotonCitaCancelada();
        renderTodo();

    } catch (error) {
        console.error('Error al cargar la configuración:', error);
        cfgBorrador = null;
        cfgGuardada = null;
        pintarErrorCarga(error);
        toast('No se pudo cargar la configuración de ' + operacionActual, 'red', 'ti-alert-triangle');
    } finally {
        cfgCargando = false;
    }
}

/*
    Sin configuración cargada, TODOS los controles de esta vista
    quedan inertes: no hay borrador que editar. Antes eso se veía
    como botones que simplemente no respondían —el de agregar
    tipología, sobre todo— sin ninguna pista de por qué.

    El caso más probable es que las reglas de seguridad nuevas
    todavía no estén desplegadas en Firebase: mientras no lo estén,
    la regla que cierra todo lo que no está declarado rechaza la
    lectura de `config/{bodega}`. Por eso ese caso se nombra
    explícitamente en vez de mostrar solo el código de error.
*/
function pintarErrorCarga(error) {

    var el = document.getElementById('cfg-error-carga');
    if (!el) return;

    if (!error) {
        el.style.display = 'none';
        return;
    }

    var esPermiso = error && error.code === 'permission-denied';

    el.style.display = '';
    el.innerHTML = '<strong>No se pudo cargar la configuración de ' + escapar(operacionActual) + '.</strong>' +
        '<ul>' +
        (esPermiso
            ? '<li>Firestore rechazó la lectura por permisos. Lo más probable es que las reglas ' +
              'nuevas (el bloque <code>config/{operacion}</code> de <code>firestore.rules</code>) ' +
              'todavía no estén desplegadas en Firebase.</li>'
            : '<li>Detalle: ' + escapar(error && error.message ? error.message : String(error)) + '</li>') +
        '<li>Mientras tanto esta vista queda deshabilitada: no hay configuración que editar.</li>' +
        '</ul>';
}

/*
    Repinta el formulario completo. Solo se llama al cargar, al
    descartar y al agregar o quitar filas — nunca desde
    renderTodo(), porque un repintado mientras alguien escribe le
    borraría lo que va digitando.
*/
function renderConfiguracion() {

    if (!cfgBorrador) return;

    document.getElementById('cfg-aviso-bodega').innerHTML =
        '<i class="ti ti-building-warehouse"></i> Estás configurando <strong>' +
        escapar(operacionActual) + ' · ' + escapar(clienteActual()) + '</strong>. ' +
        'Cada bodega tiene sus propias tipologías, tarifas y tiempos: ninguna hereda de otra.';

    document.getElementById('cfg-cliente').value = cfgBorrador.cliente || '';
    document.getElementById('cfg-muelles').value = cfgBorrador.muelles || '';
    document.getElementById('cfg-hora-corte').value = cfgBorrador.horaCorte;
    pintarNotasIdentidad();

    document.getElementById('cfg-campo-conductor').value = cfgBorrador.campos.conductor.etiqueta;
    document.getElementById('cfg-formato-conductor').value = cfgBorrador.campos.conductor.formato;
    document.getElementById('cfg-campo-cedula').value = cfgBorrador.campos.cedula.etiqueta;
    document.getElementById('cfg-formato-cedula').value = cfgBorrador.campos.cedula.formato;

    document.getElementById('cfg-cancelaciones').checked = !!cfgBorrador.manejaCancelaciones;

    document.getElementById('cfg-cobra').checked = !!cfgBorrador.cobraVehiculos;
    document.getElementById('cfg-iva').value = cfgTarifas.ivaPorcentaje;
    pintarBloqueCobro();
    document.getElementById('cfg-limite-patio').value = cfgBorrador.limitePatio || '';
    document.getElementById('cfg-minimo-cargue').value = cfgBorrador.minimoCargue;
    document.getElementById('cfg-minimo-descargue').value = cfgBorrador.minimoDescargue;
    document.getElementById('cfg-capacidad').value = cfgBorrador.capacidadDiaria || 0;
    document.getElementById('cfg-posiciones').value = cfgBorrador.posicionesTotales || 0;
    document.getElementById('cfg-hora-ocupacion').value = cfgBorrador.horaReporteOcupacion || '';
    document.getElementById('cfg-peso-cita').value = cfgBorrador.pesosNivelServicio.cita;
    document.getElementById('cfg-peso-programacion').value = cfgBorrador.pesosNivelServicio.programacion;

    pintarUrgentePatio();
    pintarNotasSalida();
    pintarNotaOcupacion();
    pintarSumaPesos();
    renderCfgTipologias();
    renderCfgAlertaVacia();
    pintarUltimaEdicion();

    document.getElementById('cfg-errores').style.display = 'none';
}

/*
    Debajo de los tres datos de identidad, qué significa lo que está
    puesto. Importa sobre todo cuando están vacíos: el panel no se
    queda sin muelles ni sin nombre, sigue usando el valor con el
    que venía operando, y decirlo evita que quien lo ve en blanco
    crea que lo acaba de borrar.
*/
/*
    Pone en pantalla los nombres de los dos campos libres: la
    etiqueta del formulario, el marcador de posición de cada uno y
    las cabeceras de las tablas donde se muestran.

    El buscador también los nombra, porque busca por ahí: decirle
    "Buscar por placa, conductor…" a quien anota proveedores lo
    manda a buscar un dato que su bodega no captura.
*/
function pintarEtiquetasCampos() {

    var conductor = rotulo('conductor');
    var cedula = rotulo('cedula');

    var lblConductor = document.getElementById('lbl-conductor');
    if (lblConductor) lblConductor.textContent = conductor + ' *';

    var lblCedula = document.getElementById('lbl-cedula');
    if (lblCedula) lblCedula.textContent = cedula;

    document.getElementById('f-conductor').placeholder = conductor;
    document.getElementById('f-cedula').placeholder = cedula;

    document.querySelectorAll('.th-conductor').forEach(function (th) {
        th.textContent = conductor;
    });

    var buscador = document.getElementById('search-input');
    if (buscador) buscador.placeholder = 'Buscar por placa, ' + conductor.toLowerCase() + ', muelle…';
}

function pintarNotasIdentidad() {

    var partida = OPERACIONES[operacionActual];

    document.getElementById('cfg-nota-cliente').textContent = cfgBorrador.cliente
        ? ''
        : 'Sin nombre configurado se sigue usando "' + partida.nombre + '".';

    document.getElementById('cfg-nota-muelles').textContent = cfgBorrador.muelles
        ? 'Los paneles mostrarán muelles del 1 al ' + cfgBorrador.muelles + '.'
        : 'Sin número configurado se siguen usando ' + partida.muelles + '.';

    var hh = dosDigitos(cfgBorrador.horaCorte, 23);
    document.getElementById('cfg-nota-hora-corte').textContent = hh
        ? 'El día operativo va de las ' + hh + ':00 a las ' + hh + ':00 del día siguiente.'
        : 'Hora fuera de rango: debe estar entre 0 y 23.';
}

function pintarUrgentePatio() {
    var u = umbralesPatio(cfgBorrador);
    document.getElementById('cfg-urgente-patio').textContent =
        u.urgente ? u.urgente + ' min' : '—';

    // El límite se digita en minutos pero se piensa en horas ("no
    // más de 2:30 en patio"), así que se dice de las dos formas.
    var nota = document.getElementById('cfg-nota-patio');
    var min = cfgBorrador.limitePatio || 0;
    nota.textContent = min
        ? 'Equivale a ' + Math.floor(min / 60) + 'h ' + (min % 60) + 'min'
        : '';
}

/*
    Debajo de cada mínimo, qué significa el número que está puesto.
    Un "100" y un "95" se ven casi iguales en el campo y sin embargo
    son dos regímenes distintos: uno admite excepción y el otro no.
*/
function pintarNotasSalida() {

    [
        { id: 'cfg-nota-descargue', valor: cfgBorrador.minimoDescargue, fase: 'descargue' },
        { id: 'cfg-nota-cargue', valor: cfgBorrador.minimoCargue, fase: 'cargue' }
    ].forEach(function (x) {
        var el = document.getElementById(x.id);
        if (!el) return;
        el.textContent = x.valor >= 100
            ? 'Sin excepción: debe llegar al 100% para salir.'
            : 'Entre ' + x.valor + '% y 99% puede salir con autorización del supervisor.';
    });
}

function pintarNotaOcupacion() {
    var el = document.getElementById('cfg-nota-ocupacion');
    if (!el) return;
    el.textContent = cfgBorrador.horaReporteOcupacion
        ? 'El supervisor verá el reporte como pendiente hasta que lo envíe.'
        : 'Sin hora definida no se le pedirá ningún reporte al supervisor.';
}

function pintarSumaPesos() {
    var p = cfgBorrador.pesosNivelServicio;
    var suma = (p.cita || 0) + (p.programacion || 0);
    var el = document.getElementById('cfg-suma-pesos');
    el.textContent = 'Suman ' + suma + '%' + (suma === 100 ? '' : ' — deben sumar exactamente 100.');
    el.className = 'cfg-suma' + (suma === 100 ? '' : ' mal');
}

function pintarUltimaEdicion() {
    var el = document.getElementById('cfg-ultima-edicion');
    if (!cfgGuardada || !cfgGuardada.actualizadoPor) {
        el.textContent = 'Esta bodega todavía no tiene configuración guardada.';
        return;
    }
    el.textContent = 'Última edición: ' + cfgGuardada.actualizadoPor;
}

/* Pesos colombianos, sin decimales: las tarifas de portería no los
   usan y los centavos solo ensucian la lectura. */
function fmtMoneda(valor) {
    return '$' + Math.round(Number(valor) || 0).toLocaleString('es-CO');
}

/* Lo digitado para una tipología. Las tarifas de una tipología
   recién creada todavía no están en el mapa. */
function tarifaDe(tipologiaId) {
    return (cfgTarifas.valores && cfgTarifas.valores[tipologiaId]) || { base: 0, tasaInlo: 0 };
}

/*
    Las tres cifras que no se digitan. Se repintan solas en cada
    tecla porque son la comprobación de que lo digitado es lo que
    se quería: quien carga la tabla la está copiando de una hoja
    donde estos números ya existen y puede compararlos de una.
*/
function textoDerivados(tipologiaId) {

    const d = desglosarTarifa(cfgTarifas, tipologiaId);

    return '<span>IVA (' + d.ivaPorcentaje + '%): <strong>' + fmtMoneda(d.iva) + '</strong></span>' +
        '<span>Valor con IVA: <strong>' + fmtMoneda(d.conIva) + '</strong></span>' +
        '<span>Total a pagar cuadrilla: <strong>' + fmtMoneda(d.cuadrilla) + '</strong></span>';
}

/*
    Guarda uno de los dos números digitados y repinta SOLO la línea
    de derivados de esa tarjeta. Repintar la lista entera en cada
    tecla le borraría al administrador el campo que va llenando.
*/
function escribirTarifa(indice, campo, valor) {

    var t = cfgBorrador.tipologias[indice];
    if (!t) return;

    var actual = cfgTarifas.valores[t.id] || { base: 0, tasaInlo: 0 };
    actual[campo] = Number(valor) || 0;
    cfgTarifas.valores[t.id] = actual;

    var el = document.getElementById('cfg-derivado-' + indice);
    if (el) el.innerHTML = textoDerivados(t.id);
}

/* Todas las líneas de derivados a la vez: lo que hace falta cuando
   cambia el IVA, que afecta a todas las tipologías por igual. */
function refrescarDerivados() {
    (cfgBorrador.tipologias || []).forEach(function (t, i) {
        var el = document.getElementById('cfg-derivado-' + i);
        if (el) el.innerHTML = textoDerivados(t.id);
    });
}

/* El % de IVA solo tiene sentido donde se cobra.

   El botón de tabla base existe en las dos bodegas que tienen una,
   pero NO cargan lo mismo: J4 carga las tarifas 2026 y J3 los
   tiempos de arrumado y paletizado. El rótulo lo dice, porque
   "Cargar tabla base" en dos sitios que hacen cosas distintas es
   pedir que alguien pulse el equivocado. */
function pintarBloqueCobro() {

    var cobra = !!(cfgBorrador && cfgBorrador.cobraVehiculos);
    document.getElementById('cfg-cobro-detalle').style.display = cobra ? '' : 'none';

    var btn = document.getElementById('btn-cfg-tabla-base');
    if (!btn) return;

    var conTiempos = distingueModalidad(cfgBorrador);

    btn.style.display = (cobra || conTiempos) ? '' : 'none';
    btn.innerHTML = conTiempos
        ? '<i class="ti ti-table-plus"></i> Cargar tabla de tiempos'
        : '<i class="ti ti-table-plus"></i> Cargar tabla 2026';
    btn.title = conTiempos
        ? 'Crea las ' + TABLA_TIEMPOS_J3.length + ' tipologías de la tabla de tiempos, con sus tiempos de arrumado y paletizado. Solo funciona si la lista está vacía.'
        : 'Crea las nueve tipologías de la tabla 2026 con sus tarifas. Solo funciona si la lista está vacía.';
}

/*
    Una tarjeta por tipología: nombre y tarifa arriba, y debajo la
    tabla de tiempos abierta por tipo de operación.

    "Ambos" tiene fila propia además de Cargue y Descargue porque
    un vehículo que hace las dos se mide de las dos maneras —cada
    fase contra su meta y el total contra la de Ambos— e incumple
    si cualquiera de las dos falla.
*/
function renderCfgTipologias() {

    var cont = document.getElementById('cfg-tipologias');
    var lista = cfgBorrador.tipologias || [];

    if (!lista.length) {
        cont.innerHTML = '<div class="cfg-vacio">' +
            '<strong>Esta bodega no tiene tipologías configuradas.</strong><br>' +
            'Mientras la lista esté vacía, los vehículos pueden entrar pero <strong>ninguno puede salir</strong>: ' +
            'la salida exige tipología para saber qué cobrar.</div>';
        return;
    }

    cont.innerHTML = lista.map(function (t, i) {

        // Solo se digita la meta. Los dos umbrales salen de ella —el
        // amarillo al pasarse, el rojo al doblarla— y se muestran al
        // lado para que quien la escribe vea de una en qué minuto va
        // a saltar cada aviso.
        // La columna de paletizado solo existe donde la bodega
        // distingue cómo viene la mercancía (hoy J3). En las demás
        // sería un campo que nadie llena y que dejaría la duda de
        // si está vacío porque no aplica o porque se olvidó.
        var conModalidad = distingueModalidad(cfgBorrador);

        var filas = TIPOS_OPERACION.map(function (op) {
            var meta = (t.tiempos[op] && t.tiempos[op].meta) || 0;
            var metaPal = (t.tiempos[op] && t.tiempos[op].metaPaletizado) || 0;
            var u = umbralesTiempo(metaEfectiva(t, op));
            return '<tr>' +
                '<td>' + op + '<span id="cfg-nota-' + i + '-' + op + '">' + notaAmbos(t, op) + '</span></td>' +
                '<td>' + inputTiempo(i, op, meta, '') + '</td>' +
                (conModalidad
                    ? '<td>' + inputTiempo(i, op, metaPal, 'Paletizado') + '</td>'
                    : '<td class="cfg-umbral" id="cfg-atencion-' + i + '-' + op + '">' + textoUmbral(u.atencion, u.urgente) + '</td>' +
                      '<td class="cfg-umbral" id="cfg-urgente-' + i + '-' + op + '">' + textoUmbral(u.urgente, null) + '</td>') +
                '</tr>';
        }).join('');

        // La tarifa solo aparece donde se cobra. En las demás bodegas
        // sería un campo que nadie llena y que la validación tendría
        // que perdonar, con la duda permanente de si está en cero
        // porque es gratis o porque se olvidó.
        //
        // Se digitan dos números —el valor antes de IVA y la tasa de
        // INLOTRANS— y los otros tres se muestran calculados debajo,
        // sin campo donde escribirlos: son fórmulas, y un derivado
        // editable es un derivado que alguien va a pisar a mano.
        var campoTarifa = cfgBorrador.cobraVehiculos
            ? '<div class="cfg-campo">' +
                  '<label>Valor antes de IVA</label>' +
                  '<input type="number" min="0" step="1" data-cfg-tarifa-base="' + i + '" value="' + tarifaDe(t.id).base + '">' +
              '</div>' +
              '<div class="cfg-campo">' +
                  '<label>Tasa de ganancia INLO</label>' +
                  '<input type="number" min="0" step="1" data-cfg-tarifa-inlo="' + i + '" value="' + tarifaDe(t.id).tasaInlo + '">' +
              '</div>'
            : '';

        return '<div class="cfg-tipologia">' +
            '<div class="cfg-tipologia-head' + (cfgBorrador.cobraVehiculos ? '' : ' sin-tarifa') + '">' +
                '<div class="cfg-campo">' +
                    '<label>Nombre de la tipología</label>' +
                    '<input type="text" data-cfg-nombre="' + i + '" value="' + escapar(t.nombre) + '" placeholder="Ej: Tractomula">' +
                '</div>' +
                campoTarifa +
                '<button class="btn btn-sm" data-cfg-borrar-tipologia="' + i + '">' +
                    '<i class="ti ti-trash"></i> Quitar' +
                '</button>' +
            '</div>' +
            (cfgBorrador.cobraVehiculos
                ? '<div class="cfg-derivados" id="cfg-derivado-' + i + '">' + textoDerivados(t.id) + '</div>'
                : '') +
            '<div class="cfg-tipologia-tabla">' +
                '<table>' +
                    '<thead><tr>' +
                        '<th>Operación</th>' +
                        (conModalidad
                            ? '<th>Arrumado <span class="cfg-th-nota">HH:MM</span></th>' +
                              '<th>Paletizado <span class="cfg-th-nota">HH:MM · vacío = no aplica</span></th>'
                            : '<th>Meta <span class="cfg-th-nota">HH:MM</span></th>' +
                              '<th>Atención <span class="cfg-th-nota">desde la meta</span></th>' +
                              '<th>Urgente <span class="cfg-th-nota">desde el doble</span></th>') +
                    '</tr></thead>' +
                    '<tbody>' + filas + '</tbody>' +
                '</table>' +
                (conModalidad
                    ? '<p class="cfg-ayuda" style="margin-top:6px;">El aviso de <strong>atención</strong> se enciende ' +
                      'al pasarse de la meta que le corresponda al vehículo —arrumado o paletizado— y el de ' +
                      '<strong>urgencia</strong> al doblarla. Un paletizado vacío significa que esa tipología no ' +
                      'llega paletizada: si aun así llegara, se mide contra la meta de arrumado.</p>'
                    : '') +
            '</div>' +
        '</div>';
    }).join('');
}

/* =========================================================
   "AMBOS" NO SE DIGITA: SE DERIVA

   Un vehículo "Ambos" descarga y después carga, cada fase con su
   propia meta. Nadie mide "el tiempo de hacer las dos cosas" como
   un número aparte, y por eso las tablas de tiempos de las
   bodegas no traen esa fila — la de J3 no la trae.

   Dejando el campo vacío, la meta sale de sumar las dos fases:
   es el tiempo que el vehículo va a estar en muelle. El campo
   sigue ahí por si alguna bodega quiere fijarlo aparte, y lo que
   se escriba manda sobre lo derivado. Misma regla que aplica
   tiemposDe() en config.js — aquí solo se muestra.
   ========================================================= */

/* El campo que rige según la modalidad. Sin modalidad —o sin
   paletizado configurado— manda `meta`, que es la de arrumado y la
   meta única de las bodegas que no distinguen. Misma regla que
   aplica tiemposDe() en config.js. */
function metaSegun(tiempos, modalidad) {
    if (!tiempos) return 0;
    if (modalidad === 'Paletizado' && tiempos.metaPaletizado) return tiempos.metaPaletizado;
    return tiempos.meta || 0;
}

function metaDerivadaAmbos(t, modalidad) {
    var c = metaSegun(t.tiempos.Cargue, modalidad);
    var d = metaSegun(t.tiempos.Descargue, modalidad);
    return c && d ? c + d : 0;
}

/* La meta que realmente rige esa fila: la digitada, o la derivada
   cuando es "Ambos" y está vacía. */
function metaEfectiva(t, op, modalidad) {
    var meta = metaSegun(t.tiempos[op], modalidad);
    if (meta) return meta;
    return op === 'Ambos' ? metaDerivadaAmbos(t, modalidad) : 0;
}

/* El aviso al lado del rótulo "Ambos", para que un campo vacío no
   se lea como un campo sin llenar. Donde se distingue modalidad se
   dicen las dos derivadas: son dos números distintos y mostrar uno
   solo haría pensar que el otro no existe. */
function notaAmbos(t, op) {

    if (op !== 'Ambos') return '';

    if ((t.tiempos.Ambos && t.tiempos.Ambos.meta) || 0) {
        return ' <span class="cfg-th-nota">fijada a mano</span>';
    }

    var arr = metaDerivadaAmbos(t, 'Arrumado');

    if (!distingueModalidad(cfgBorrador)) {
        return arr
            ? ' <span class="cfg-th-nota">se deriva: ' + formatDuration(arr) + '</span>'
            : ' <span class="cfg-th-nota">se deriva de las dos fases</span>';
    }

    var pal = metaDerivadaAmbos(t, 'Paletizado');
    if (!arr && !pal) return ' <span class="cfg-th-nota">se deriva de las dos fases</span>';

    return ' <span class="cfg-th-nota">se deriva: ' +
           (arr ? 'arrumado ' + formatDuration(arr) : '') +
           (arr && pal && pal !== arr ? ' · ' : '') +
           (pal && pal !== arr ? 'paletizado ' + formatDuration(pal) : '') +
           '</span>';
}

/* La meta se digita en HH:MM porque así vienen escritas las tablas
   de tiempos de las bodegas ("03:30", "00:45"). Obligar a convertir
   a minutos de cabeza es pedir que alguien se equivoque. Sigue
   aceptando minutos sueltos si alguien los escribe — lo resuelve
   minutosDesdeHHMM(). */
function inputTiempo(indice, operacion, valor, modalidad) {
    // El atributo lleva "indice:operacion:modalidad". La modalidad
    // vacía es la meta de arrumado, que es también la meta única de
    // las bodegas que no distinguen.
    return '<input type="text" inputmode="numeric" placeholder="HH:MM" value="' +
           hhmmDesdeMinutos(valor || 0) +
           '" data-cfg-tiempo="' + indice + ':' + operacion + ':' + (modalidad || '') + '">';
}

/*
    Un umbral calculado, dicho como la franja que abre: "45 a 90
    min" para el amarillo, "desde 90 min" para el rojo. El rango
    importa porque es lo que el usuario tiene en la cabeza —"de
    aquí hasta que se duplique"— y un número suelto no lo dice.
*/
function textoUmbral(desde, hasta) {
    if (!desde) return '—';
    // formatDuration da "3h 30min" en vez de "210 min": con metas de
    // varias horas, los minutos sueltos hay que dividirlos de cabeza
    // para saber de qué se está hablando.
    return hasta
        ? formatDuration(desde) + ' a ' + formatDuration(hasta)
        : 'desde ' + formatDuration(desde);
}

/* Los dos umbrales de una fila, cuando cambia su meta. Se repinta
   solo esa fila: repintar la lista entera le borraría al
   administrador el campo que va digitando. */
function pintarUmbralesTiempo(indice, operacion) {

    var t = cfgBorrador.tipologias[indice];
    if (!t) return;

    pintarUmbralesFila(t, indice, operacion);

    // Cambiar cargue o descargue mueve la meta derivada de "Ambos",
    // que está en otra fila: si no se repinta también, queda
    // mostrando el total anterior.
    if (operacion === 'Cargue' || operacion === 'Descargue') {
        pintarUmbralesFila(t, indice, 'Ambos');
    }
}

function pintarUmbralesFila(t, indice, operacion) {

    var u = umbralesTiempo(metaEfectiva(t, operacion));

    var atencion = document.getElementById('cfg-atencion-' + indice + '-' + operacion);
    var urgente = document.getElementById('cfg-urgente-' + indice + '-' + operacion);

    if (atencion) atencion.textContent = textoUmbral(u.atencion, u.urgente);
    if (urgente) urgente.textContent = textoUmbral(u.urgente, null);

    var nota = document.getElementById('cfg-nota-' + indice + '-' + operacion);
    if (nota) nota.innerHTML = notaAmbos(t, operacion);
}

/*
    El aviso de parada de operación. Se calcula sobre la
    configuración GUARDADA, no sobre el borrador: lo que bloquea la
    salida es lo que está publicado, no lo que alguien tiene a
    medio escribir en pantalla.

    Vive aparte de renderConfiguracion() porque depende de
    `registros`, que cambia con cada snapshot: hay que poder
    refrescarlo sin repintar el formulario entero.
*/
function renderCfgAlertaVacia() {

    var el = document.getElementById('cfg-alerta-vacia');
    if (!el || !cfgGuardada) return;

    if (hayTipologias(cfgGuardada)) {
        el.style.display = 'none';
        return;
    }

    var adentro = registros.filter(function (r) { return !r.horaSalida; }).length;

    el.style.display = '';
    el.innerHTML = '<i class="ti ti-alert-triangle"></i> <strong>' + escapar(operacionActual) +
        ' no tiene ninguna tipología configurada.</strong> Los vehículos pueden entrar, pero ninguno ' +
        'podrá salir hasta que exista al menos una tipología con su tarifa y sus tiempos.' +
        (adentro ? ' Hay <strong>' + adentro + ' vehículo(s) adentro</strong> en esta condición ahora mismo.' : '');
}

function agregarTipologia() {
    // Sin borrador no hay nada que editar. Se avisa en vez de no
    // hacer nada: un botón que no responde parece roto.
    if (!cfgBorrador) {
        toast('La configuración no se pudo cargar — revisa el aviso de arriba', 'red', 'ti-alert-triangle');
        return;
    }
    var t = nuevaTipologia('');
    cfgBorrador.tipologias.push(t);
    cfgTarifas.valores[t.id] = { base: 0, tasaInlo: 0 };
    renderCfgTipologias();
}

/* =========================================================
   TABLA DE TARIFAS DE PARTIDA

   Los nueve tipos de vehículo del descargue de CEDI Funza con
   los valores de 2026, tal como vienen de la hoja de cálculo del
   cliente. Es un ATAJO PARA NO DIGITAR, no la fuente de verdad:
   lo que manda es lo que quede guardado en Firestore, y estos
   números se editan encima antes o después de guardar.

   Solo se ofrece cuando la lista está vacía. Si mañana la tabla
   cambia, se cambia allá y esta constante se borra: no se
   consulta en ningún otro punto de la aplicación.
   ========================================================= */

const TABLA_TARIFAS_2026 = [
    { nombre: "TIPO 100",           base: 38000,  tasaInlo: 10000 },
    { nombre: "TIPO 300",           base: 61000,  tasaInlo: 10000 },
    { nombre: "TIPO 500",           base: 121000, tasaInlo: 10000 },
    { nombre: "TIPO 5.5",           base: 131000, tasaInlo: 10000 },
    { nombre: "TIPO 600",           base: 156000, tasaInlo: 10000 },
    { nombre: "TIPO DT",            base: 231000, tasaInlo: 10000 },
    { nombre: "TIPO TRACTO CAMION", base: 298000, tasaInlo: 30000 },
    { nombre: "TIPO CAMA BAJA",     base: 453000, tasaInlo: 30000 },
    { nombre: "CONTENEDOR (20PL)",  base: 167000, tasaInlo: 10000 }
];

/* =========================================================
   TABLA DE TIEMPOS DE J3

   Copiada literal de la tabla de la bodega, en HH:MM y no en
   minutos, para que se pueda cotejar fila por fila contra el
   original sin hacer cuentas. Las celdas vacías son los "N/A":
   esa tipología no llega paletizada.

   Cargue y descargue traen hoy los mismos números y aun así se
   guardan por separado, a propósito: son dos metas distintas que
   hoy coinciden, y colapsarlas obligaría a partirlas otra vez el
   día que dejen de coincidir.

   Vive aquí, en el panel, y no en el servicio de configuración:
   esto es una carga inicial para no digitar veintiocho números a
   mano, no una regla del sistema. Lo que mande después es lo que
   quede guardado en Firestore.
   ========================================================= */

const TABLA_TIEMPOS_J3 = [
    { nombre: "MULA EXTRA DIMENSIONADO", cargue: "03:30", carguePal: "00:45", descargue: "03:30", descarguePal: "00:45" },
    { nombre: "TURBO",                   cargue: "01:00", carguePal: "",      descargue: "01:00", descarguePal: ""      },
    { nombre: "SENCILLO",                cargue: "01:45", carguePal: "",      descargue: "01:45", descarguePal: ""      },
    { nombre: "MULA 20",                 cargue: "01:45", carguePal: "00:30", descargue: "01:45", descarguePal: "00:30" },
    { nombre: "MULA 40",                 cargue: "02:20", carguePal: "00:30", descargue: "02:20", descarguePal: "00:30" },
    { nombre: "NPR",                     cargue: "01:45", carguePal: "",      descargue: "01:45", descarguePal: ""      },
    { nombre: "NHR",                     cargue: "01:00", carguePal: "",      descargue: "01:00", descarguePal: ""      }
];

function sembrarTiemposJ3() {

    if (!confirm('Se van a crear las ' + TABLA_TIEMPOS_J3.length + ' tipologías de la tabla de tiempos en ' +
                 operacionActual + ', con sus tiempos de arrumado y paletizado. Podrás revisarlas antes de guardar. ¿Continuar?')) return;

    TABLA_TIEMPOS_J3.forEach(function (fila) {

        var t = nuevaTipologia(fila.nombre);

        // "Ambos" se queda en cero: se deriva de las dos fases.
        t.tiempos.Cargue = {
            meta: minutosDesdeHHMM(fila.cargue),
            metaPaletizado: minutosDesdeHHMM(fila.carguePal)
        };
        t.tiempos.Descargue = {
            meta: minutosDesdeHHMM(fila.descargue),
            metaPaletizado: minutosDesdeHHMM(fila.descarguePal)
        };

        cfgBorrador.tipologias.push(t);
    });

    renderCfgTipologias();
    toast('Tabla de tiempos cargada — revísala y pulsa Guardar', 'green', 'ti-table-plus');
}

function sembrarTablaBase() {

    if (!cfgBorrador) {
        toast('La configuración no se pudo cargar — revisa el aviso de arriba', 'red', 'ti-alert-triangle');
        return;
    }

    // Con tipologías ya creadas no se siembra nada, cualquiera sea
    // la tabla: los vehículos registrados apuntan a esos ids.
    if (cfgBorrador.tipologias.length) {
        toast('Esta bodega ya tiene tipologías — la tabla base solo carga sobre una lista vacía', 'amber', 'ti-alert-circle');
        return;
    }

    // Cada bodega tiene la suya: J3 carga tiempos por modalidad,
    // J4 carga tarifas. Son tablas distintas, no dos versiones de
    // la misma.
    if (distingueModalidad(cfgBorrador)) {
        sembrarTiemposJ3();
        return;
    }

    if (!confirm('Se van a crear ' + TABLA_TARIFAS_2026.length + ' tipologías con las tarifas de la tabla 2026 ' +
                 '(descargue CEDI Funza) en ' + operacionActual + '. Podrás editarlas antes de guardar. ¿Continuar?')) return;

    TABLA_TARIFAS_2026.forEach(function (fila) {
        var t = nuevaTipologia(fila.nombre);
        cfgBorrador.tipologias.push(t);
        cfgTarifas.valores[t.id] = { base: fila.base, tasaInlo: fila.tasaInlo };
    });

    renderCfgTipologias();
    toast('Tabla cargada — revísala y pulsa Guardar', 'green', 'ti-table-plus');
}

function borrarTipologia(indice) {

    if (!cfgBorrador) return;
    var t = cfgBorrador.tipologias[indice];
    if (!t) return;

    var etiqueta = t.nombre ? '"' + t.nombre + '"' : 'esta tipología';
    if (!confirm('¿Quitar ' + etiqueta + '? Los vehículos ya registrados con ella conservan su tarifa: se congela al momento de la entrada.')) return;

    cfgBorrador.tipologias.splice(indice, 1);
    delete cfgTarifas.valores[t.id];
    renderCfgTipologias();
}

function pintarErroresConfig(errores) {

    var el = document.getElementById('cfg-errores');

    if (!errores.length) {
        el.style.display = 'none';
        return;
    }

    el.style.display = '';
    el.innerHTML = '<strong>No se guardó: falta corregir ' + errores.length + ' cosa(s).</strong><ul>' +
        errores.map(function (e) { return '<li>' + escapar(e) + '</li>'; }).join('') + '</ul>';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function guardarConfiguracion() {

    if (!cfgBorrador) return;

    // Los nombres se guardan sin espacios de sobra: "Turbo " y
    // "Turbo" se verían iguales en pantalla y contarían como dos
    // tipologías distintas en los indicadores.
    cfgBorrador.cliente = (cfgBorrador.cliente || '').trim();
    cfgBorrador.campos.conductor.etiqueta = (cfgBorrador.campos.conductor.etiqueta || '').trim();
    cfgBorrador.campos.cedula.etiqueta = (cfgBorrador.campos.cedula.etiqueta || '').trim();
    cfgBorrador.tipologias.forEach(function (t) { t.nombre = (t.nombre || '').trim(); });

    var errores = validarConfig(cfgBorrador, cfgTarifas);
    pintarErroresConfig(errores);
    if (errores.length) {
        toast('Revisa los datos marcados', 'red', 'ti-alert-circle');
        return;
    }

    setSyncStatus('syncing');

    try {
        await guardarConfig(operacionActual, cfgBorrador, perfilActual.nombre);
        await guardarTarifas(operacionActual, cfgTarifas, perfilActual.nombre);

        setSyncStatus('ok');
        toast('Configuración de ' + operacionActual + ' guardada', 'green', 'ti-check');

        await cargarConfiguracion();

    } catch (error) {
        console.error('Error al guardar la configuración:', error);
        setSyncStatus('error');
        toast('No se pudo guardar la configuración', 'red', 'ti-alert-triangle');
    }
}

function descartarConfiguracion() {
    if (!cfgGuardada) return;
    if (cfgHayCambios() && !confirm('¿Descartar los cambios sin guardar?')) return;
    cfgBorrador = JSON.parse(JSON.stringify(cfgGuardada));
    cfgTarifas = JSON.parse(JSON.stringify(cfgTarifasGuardadas));
    renderConfiguracion();
}

/*
    Los campos de las tipologías se generan sobre la marcha, así
    que sus eventos van por delegación igual que los botones. Se
    escucha 'input' y no 'change' para que la suma de los pesos y
    el umbral derivado de patio se actualicen mientras se escribe.
*/
function wireConfiguracion() {

    document.getElementById('btn-cfg-nueva-tipologia').addEventListener('click', agregarTipologia);
    document.getElementById('btn-cfg-tabla-base').addEventListener('click', sembrarTablaBase);
    document.getElementById('btn-cfg-guardar').addEventListener('click', guardarConfiguracion);
    document.getElementById('btn-cfg-descartar').addEventListener('click', descartarConfiguracion);

    // Cambiar si la bodega cobra agrega o quita los campos de tarifa
    // de todas las tarjetas, así que hay que repintarlas.
    document.getElementById('cfg-cobra').addEventListener('change', function (e) {
        if (!cfgBorrador) return;
        cfgBorrador.cobraVehiculos = e.target.checked;
        pintarBloqueCobro();
        renderCfgTipologias();
    });

    document.getElementById('cfg-cliente').addEventListener('input', function (e) {
        if (!cfgBorrador) return;
        cfgBorrador.cliente = e.target.value;
        pintarNotasIdentidad();
    });

    document.getElementById('cfg-muelles').addEventListener('input', function (e) {
        if (!cfgBorrador) return;
        cfgBorrador.muelles = Number(e.target.value) || 0;
        pintarNotasIdentidad();
    });

    document.getElementById('cfg-hora-corte').addEventListener('input', function (e) {
        if (!cfgBorrador) return;
        cfgBorrador.horaCorte = Number(e.target.value) || 0;
        pintarNotasIdentidad();
    });

    // Los rótulos de los dos campos libres. Al cambiarlos se
    // repinta el formulario de entrada, que es donde se ven.
    [
        { input: 'cfg-campo-conductor', select: 'cfg-formato-conductor', campo: 'conductor' },
        { input: 'cfg-campo-cedula', select: 'cfg-formato-cedula', campo: 'cedula' }
    ].forEach(function (x) {

        document.getElementById(x.input).addEventListener('input', function (e) {
            if (!cfgBorrador) return;
            cfgBorrador.campos[x.campo].etiqueta = e.target.value;
        });

        document.getElementById(x.select).addEventListener('change', function (e) {
            if (!cfgBorrador) return;
            cfgBorrador.campos[x.campo].formato = e.target.value;
        });
    });

    document.getElementById('cfg-cancelaciones').addEventListener('change', function (e) {
        if (!cfgBorrador) return;
        cfgBorrador.manejaCancelaciones = e.target.checked;
    });

    // El IVA es uno solo para toda la bodega: al cambiarlo se
    // recalculan los derivados de las nueve tarjetas.
    document.getElementById('cfg-iva').addEventListener('input', function (e) {
        if (!cfgBorrador) return;
        cfgTarifas.ivaPorcentaje = Number(e.target.value) || 0;
        refrescarDerivados();
    });

    // Todos comprueban el borrador: la vista existe en el DOM desde
    // que carga la página, pero la configuración llega después de
    // Firestore y hasta entonces no hay nada que editar.
    document.getElementById('cfg-limite-patio').addEventListener('input', function (e) {
        if (!cfgBorrador) return;
        cfgBorrador.limitePatio = Number(e.target.value) || 0;
        pintarUrgentePatio();
    });

    document.getElementById('cfg-minimo-cargue').addEventListener('input', function (e) {
        if (!cfgBorrador) return;
        cfgBorrador.minimoCargue = Number(e.target.value) || 0;
        pintarNotasSalida();
    });

    document.getElementById('cfg-minimo-descargue').addEventListener('input', function (e) {
        if (!cfgBorrador) return;
        cfgBorrador.minimoDescargue = Number(e.target.value) || 0;
        pintarNotasSalida();
    });

    document.getElementById('cfg-capacidad').addEventListener('input', function (e) {
        if (!cfgBorrador) return;
        cfgBorrador.capacidadDiaria = Number(e.target.value) || 0;
    });

    document.getElementById('cfg-posiciones').addEventListener('input', function (e) {
        if (!cfgBorrador) return;
        cfgBorrador.posicionesTotales = Number(e.target.value) || 0;
    });

    document.getElementById('cfg-hora-ocupacion').addEventListener('change', function (e) {
        if (!cfgBorrador) return;
        cfgBorrador.horaReporteOcupacion = e.target.value || '';
        pintarNotaOcupacion();
    });

    document.getElementById('cfg-peso-cita').addEventListener('input', function (e) {
        if (!cfgBorrador) return;
        cfgBorrador.pesosNivelServicio.cita = Number(e.target.value) || 0;
        pintarSumaPesos();
    });

    document.getElementById('cfg-peso-programacion').addEventListener('input', function (e) {
        if (!cfgBorrador) return;
        cfgBorrador.pesosNivelServicio.programacion = Number(e.target.value) || 0;
        pintarSumaPesos();
    });

    var cont = document.getElementById('view-configuracion');

    cont.addEventListener('input', function (e) {

        if (!cfgBorrador) return;

        var nombre = e.target.getAttribute('data-cfg-nombre');
        if (nombre !== null) {
            cfgBorrador.tipologias[Number(nombre)].nombre = e.target.value;
            return;
        }

        var base = e.target.getAttribute('data-cfg-tarifa-base');
        if (base !== null) {
            escribirTarifa(Number(base), 'base', e.target.value);
            return;
        }

        var inlo = e.target.getAttribute('data-cfg-tarifa-inlo');
        if (inlo !== null) {
            escribirTarifa(Number(inlo), 'tasaInlo', e.target.value);
            return;
        }

        var tiempo = e.target.getAttribute('data-cfg-tiempo');
        if (tiempo !== null) {
            // El atributo es "indice:operacion:modalidad"; el VALOR
            // puede traer otro ":" si viene en HH:MM, así que se
            // parte el atributo y no lo que el usuario escribió.
            var partes = tiempo.split(':');
            var fila = cfgBorrador.tipologias[Number(partes[0])];
            if (fila) {
                var op = partes[1];
                var campo = partes[2] === 'Paletizado' ? 'metaPaletizado' : 'meta';
                // Se conserva el otro número de la misma operación:
                // reemplazar el objeto entero borraría el de al lado.
                if (!fila.tiempos[op]) fila.tiempos[op] = { meta: 0, metaPaletizado: 0 };
                fila.tiempos[op][campo] = minutosDesdeHHMM(e.target.value);
                pintarUmbralesTiempo(Number(partes[0]), op);
            }
        }
    });

    cont.addEventListener('click', function (e) {

        if (!cfgBorrador) return;

        var borrar = e.target.closest('[data-cfg-borrar-tipologia]');
        if (borrar) borrarTipologia(Number(borrar.getAttribute('data-cfg-borrar-tipologia')));
    });
}


/* =========================================================
   DELEGACIÓN DE EVENTOS (para los botones generados dinámicamente)
   ========================================================= */

function wireDelegatedClicks() {
    document.body.addEventListener('click', function (e) {

        var btnEditar = e.target.closest('[data-editar]');
        if (btnEditar) { openModalEditar(btnEditar.getAttribute('data-editar')); return; }

        var btnObservacion = e.target.closest('[data-observacion]');
        if (btnObservacion) { openModalObservacion(btnObservacion.getAttribute('data-observacion')); return; }

        var btnSalida = e.target.closest('[data-salida]');
        if (btnSalida) { openModalSalida(btnSalida.getAttribute('data-salida')); return; }

        var btnDetalle = e.target.closest('[data-detalle]');
        if (btnDetalle) { openModalDetalle(btnDetalle.getAttribute('data-detalle')); return; }

        var btnEliminar = e.target.closest('[data-eliminar]');
        if (btnEliminar) { eliminarRegistro(btnEliminar.getAttribute('data-eliminar')); return; }

        var btnCancelar = e.target.closest('[data-cancelar]');
        if (btnCancelar) { openModalCancelar(btnCancelar.getAttribute('data-cancelar')); return; }

        var btnCorregir = e.target.closest('[data-corregir]');
        if (btnCorregir) { openModalCorregir(btnCorregir.getAttribute('data-corregir')); return; }

        var btnCobrar = e.target.closest('[data-cobrar]');
        if (btnCobrar) { openModalCobro(btnCobrar.getAttribute('data-cobrar')); return; }

        // "id:Modalidad" — el id no lleva ":", así que basta con
        // partir por el primero.
        var btnModalidad = e.target.closest('[data-modalidad]');
        if (btnModalidad) {
            var partesMod = btnModalidad.getAttribute('data-modalidad').split(':');
            marcarModalidad(partesMod[0], partesMod[1]);
            return;
        }

        var btnAgregarOp = e.target.closest('[data-agregar-operacion]');
        if (btnAgregarOp) { confirmarAgregarOperacion(btnAgregarOp.getAttribute('data-agregar-operacion')); return; }

        var btnAvanceTipo = e.target.closest('[data-avance-tipo]');
        if (btnAvanceTipo) {
            var partesTipo = btnAvanceTipo.getAttribute('data-avance-tipo').split(':');
            seleccionarAvanceTipo(partesTipo[0], partesTipo[1]);
            return;
        }

        var btnAvanceAdd = e.target.closest('[data-avance-add]');
        if (btnAvanceAdd) {
            var partesAdd = btnAvanceAdd.getAttribute('data-avance-add').split(':');
            incrementarAvance(partesAdd[0], Number(partesAdd[1]));
            return;
        }

        var btnAutorizar = e.target.closest('[data-autorizar]');
        if (btnAutorizar) { autorizarSalida(btnAutorizar.getAttribute('data-autorizar')); return; }

        var btnClose = e.target.closest('[data-close]');
        if (btnClose) { closeModal(btnClose.getAttribute('data-close')); return; }

        var navBtn = e.target.closest('.nav-item[data-view]');
        if (navBtn) { showView(navBtn.getAttribute('data-view')); return; }

        var viewBtn = e.target.closest('[data-view]');
        if (viewBtn && !viewBtn.classList.contains('nav-item')) { showView(viewBtn.getAttribute('data-view')); return; }

        var pillBtn = e.target.closest('.pill[data-filter]');
        if (pillBtn) { setFilter(pillBtn.getAttribute('data-filter'), pillBtn); return; }
    });
}


/* =========================================================
   INIT
   ========================================================= */

function iniciarPagina(perfil) {

    perfilActual = perfil;

    document.getElementById('op-nombre').textContent = perfil.nombre || perfil.uid;
    document.getElementById('op-nombre-top').textContent = perfil.nombre || perfil.uid;
    document.getElementById('op-avatar').textContent = initials(perfil.nombre || '?');

    var d = new Date();
    document.getElementById('topbar-date').textContent = d.toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    escribirFechaHora('f-fecha-ingreso', 'f-hora-h', 'f-hora-m', nowLocal());
    var ayer = new Date(today() + 'T00:00:00');
    ayer.setDate(ayer.getDate() - 1);
    document.getElementById('f-fecha-ingreso').min = ayer.toISOString().slice(0, 10);
    document.getElementById('f-fecha-ingreso').max = today();

    // Selector de operación del topbar (J3 / J4 / B9)
    document.getElementById('selector-operacion').addEventListener('change', function (e) {
        cambiarOperacion(e.target.value);
    });

    // Controles propios de la caja de on time (esta vista no tiene
    // los selectores de periodo y canal que sí trae el supervisor).
    iniciarPeriodoEstadisticas();

    document.getElementById('reg-desde').addEventListener('change', renderRegistros);
    document.getElementById('reg-hasta').addEventListener('change', renderRegistros);
    document.getElementById('btn-limpiar-fechas').addEventListener('click', function () {
        document.getElementById('reg-desde').value = '';
        document.getElementById('reg-hasta').value = '';
        renderRegistros();
    });

    pintarEtiquetasOperacion();
    suscribir();

    // Eventos del formulario
    document.getElementById('f-ubicacion').addEventListener('change', cambiarUbicacion);
    document.getElementById('f-programado').addEventListener('change', cambiarProgramado);
    document.getElementById('f-servicio-tipo').addEventListener('change', cambiarServicioTipo);
    document.querySelectorAll('input[name=tipo]').forEach(function (chk) { chk.addEventListener('change', syncTipoUI); });
    document.getElementById('btn-limpiar').addEventListener('click', limpiarForm);
    document.getElementById('btn-registrar').addEventListener('click', registrarEntrada);

    // Saneamiento en vivo: los dos campos libres según el formato que
    // les fije la bodega, y horas/minutos nunca fuera de 0-23 / 0-59.
    document.getElementById('f-conductor').addEventListener('input', function (e) { filtrarSegunFormato(e, 'conductor'); });
    document.getElementById('f-cedula').addEventListener('input', function (e) { filtrarSegunFormato(e, 'cedula'); });
    document.getElementById('f-hora-h').addEventListener('input', function (e) { limitarHora(e, 23); });
    document.getElementById('f-hora-m').addEventListener('input', function (e) { limitarHora(e, 59); });
    document.getElementById('f-hora-programacion-h').addEventListener('input', function (e) { limitarHora(e, 23); });
    document.getElementById('f-hora-programacion-m').addEventListener('input', function (e) { limitarHora(e, 59); });
    document.getElementById('m-hora-salida-h').addEventListener('input', function (e) { limitarHora(e, 23); });
    document.getElementById('m-hora-salida-m').addEventListener('input', function (e) { limitarHora(e, 59); });

    // Registros: búsqueda
    document.getElementById('search-input').addEventListener('input', renderRegistros);

    // Modales
    document.getElementById('e-ubicacion').addEventListener('change', cambiarUbicacionEdit);
    document.getElementById('btn-confirmar-salida').addEventListener('click', confirmarSalida);
    document.getElementById('btn-confirmar-edicion').addEventListener('click', confirmarEdicionUbicacion);
    document.getElementById('btn-confirmar-observacion').addEventListener('click', confirmarObservacion);
    document.getElementById('btn-confirmar-tipologia').addEventListener('click', confirmarTipologia);

    // Cancelaciones
    document.getElementById('btn-confirmar-cancelar').addEventListener('click', confirmarCancelacion);
    document.getElementById('btn-confirmar-cita').addEventListener('click', confirmarCitaCancelada);
    document.getElementById('btn-cita-cancelada').addEventListener('click', openModalCitaCancelada);

    // Corrección de los datos del registro y cobros. Las dos cosas
    // que solo tenía el supervisor de J4 y que ahora también ejerce
    // el administrador, en cualquiera de las tres bodegas.
    document.getElementById('btn-confirmar-correccion').addEventListener('click', confirmarCorreccion);
    wireCobros();

    // Los campos de hora del modal de corrección: mismo saneamiento
    // en vivo que el resto del panel.
    document.getElementById('ed-hora-h').addEventListener('input', function (e) { limitarHora(e, 23); });
    document.getElementById('ed-hora-m').addEventListener('input', function (e) { limitarHora(e, 59); });
    document.getElementById('ed-cita-h').addEventListener('input', function (e) { limitarHora(e, 23); });
    document.getElementById('ed-cita-m').addEventListener('input', function (e) { limitarHora(e, 59); });
    document.getElementById('ed-conductor').addEventListener('input', function (e) { filtrarSegunFormato(e, 'conductor'); });
    document.getElementById('ed-cedula').addEventListener('input', function (e) { filtrarSegunFormato(e, 'cedula'); });

    // Configuración de la bodega
    wireConfiguracion();
    cargarConfiguracion();

    // Exportar
    document.getElementById('btn-export-todos').addEventListener('click', exportarTodos);
    document.getElementById('btn-export-hoy').addEventListener('click', exportarHoy);
    document.getElementById('btn-export-rango').addEventListener('click', exportarRango);

    // Filtro global de canal, el mismo que tienen supervisor y cliente.
    document.getElementById('filtro-canal').addEventListener('change', function (e) {
        canalFiltro = e.target.value;
        sincronizarSelectoresCanal();
        renderTodo();
    });

    // Sidebar móvil
    document.getElementById('btn-menu-toggle').addEventListener('click', toggleSidebar);
    document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);

    document.getElementById('btn-cerrar-sesion').addEventListener('click', salir);

    wireDelegatedClicks();

    syncTipoUI();
    cambiarServicioTipo();
    renderTodo();
}


// Sin `operacion`: el administrador no está atado a una bodega,
// entra a todas y elige cuál ver con el selector del topbar.
protegerPagina({
    rolesPermitidos: ["administrador"]
}).then(iniciarPagina).catch(function (error) {
    console.warn('Acceso bloqueado:', error.message);
});

window.addEventListener('beforeunload', function () {
    if (unsubscribeRegistros) unsubscribeRegistros();
});