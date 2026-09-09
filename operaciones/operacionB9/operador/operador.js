/* =========================================================
   INLOTRANS — Operación B9 — Operador

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

import { protegerPagina } from "../../../shared/core/guard.js";
import { cerrarSesionFirebase } from "../../../shared/core/auth.js";
import { cerrarSesionLocal } from "../../../shared/core/session.js";

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
    estaCancelado
} from "../../../shared/services/vehiculos.js";

import {
    canalDe,
    getDestino,
    getHistorial,
    getDiaOperativo,
    getLocationDurations,
    minutosEnPatio,
    minutosEnMuelle,
    nivelContraMeta,
    faseActual,
    ordenarPorPrioridad,
    prioridadDe,
    enMuelleFueraDeMeta,
    promedioMinutos,
    tituloHistorial
} from "../../../shared/services/eventos.js";

import {
    suscribirseAConfig,
    tiemposDe,
    modalidadDe,
    distingueModalidad,
    etiquetaCampo,
    formatoCampo,
    limpiarSegunFormato,
    errorDeFormato
} from "../../../shared/services/config.js";

import { fichaVehiculo } from "../../../shared/services/detalleVehiculo.js";

import { nowLocal, today, fmtDt, formatDuration, fechaDentroDeRango, todayOperativo } from "../../../shared/utils/tiempos.js";
import { exportarExcel } from "../../../shared/utils/excel.js";

const OPERACION = "B9";
const RUTA_LOGIN = "../../../index.html";

/* El número de muelles y el corte del turno los fija ahora el
   administrador en config/{OPERACION}. Estos dos son el valor de
   partida: el que se usa mientras Firestore responde y el que se
   mantiene si esa bodega todavía no los tiene configurados.

   El corte del turno es el mismo que usan supervisor y cliente: el
   "día" va de 6am a 6am, no de medianoche a medianoche. Sin esto,
   los promedios del dashboard cortarían el turno por la mitad. */
const MUELLES_POR_DEFECTO = 4;
const HORA_CORTE_POR_DEFECTO = 6;

/* El nombre del cliente no es decorativo aquí: se guarda en el
   registro del vehículo como empresa del servicio de insumos. Por
   eso también sale de la configuración y no de un texto fijo. */
const CLIENTE_POR_DEFECTO = 'EMMA';

let numMuelles = MUELLES_POR_DEFECTO;
let horaCorte = HORA_CORTE_POR_DEFECTO;

function clienteBodega() {
    return (configBodega && configBodega.cliente) || CLIENTE_POR_DEFECTO;
}

/* Cómo se llaman hoy los dos campos libres de la entrada. En J3 y
   B9 son el conductor y su cédula; en J4, el proveedor y el número
   de la cita. Se preguntan aquí y no se escriben sueltos en cada
   tabla para que renombrarlos sea un solo cambio. */
function rotulo(campo) {
    return etiquetaCampo(configBodega, campo);
}

/* Cómo se titulan esas dos columnas en la hoja de Excel. */
function etiquetasExport() {
    return { conductor: rotulo('conductor'), cedula: rotulo('cedula') };
}

let registros = [];
let selectedId = null;
let currentFilter = 'todos';
let unsubscribeRegistros = null;
let unsubscribeConfig = null;
let perfilActual = null;

/* Configuración de la bodega (config/B9). De aquí sale la lista de
   tipologías del formulario de entrada. Empieza en null: hasta que
   Firestore responda, el <select> muestra que está cargando en vez
   de un desplegable vacío que parecería roto. */
let configBodega = null;


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
   y ese formato lo pone el administrador por bodega: el nombre de
   un conductor no lleva números, pero el de un proveedor sí puede
   ("Distribuidora 3M S.A.S."). */
function filtrarSegunFormato(e, campo) {
    e.target.value = limpiarSegunFormato(e.target.value, formatoCampo(configBodega, campo));
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

    var titulos = { dashboard: 'Dashboard', entrada: 'Registrar entrada', registros: 'Registros', exportar: 'Exportar datos' };
    document.getElementById('topbar-title').textContent = titulos[v] || v;

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


/* Hasta qué muelle llega el tablero. Lo pinta el JS y no viene fijo
   en el HTML porque el número sale de la configuración de la bodega
   y puede cambiar sin desplegar nada. */
function pintarTituloMuelles() {
    var el = document.getElementById('muelles-titulo');
    if (el) el.textContent = 'Muelles (1 a ' + numMuelles + ')';
}

/*
    Pone en pantalla los nombres de los dos campos libres: la
    etiqueta del formulario, el texto de ayuda de cada uno y las
    cabeceras de las tablas donde se muestran.

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

    var inpConductor = document.getElementById('f-conductor');
    if (inpConductor) inpConductor.placeholder = conductor;

    var inpCedula = document.getElementById('f-cedula');
    if (inpCedula) inpCedula.placeholder = cedula;

    document.querySelectorAll('.th-conductor').forEach(function (th) {
        th.textContent = conductor;
    });

    var buscador = document.getElementById('search-input');
    if (buscador) buscador.placeholder = 'Buscar por placa, ' + conductor.toLowerCase() + ', muelle…';
}


function renderDashboard() {

    if (!document.getElementById('view-dashboard').classList.contains('active')) return;

    var enPatio = getRegistrosEnPatio(registros);
    var enMuelle = getRegistrosEnMuelle(registros);
    var activos = registros.filter(function (r) { return !r.horaSalida; });

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
    var diaOp = todayOperativo(horaCorte);
    var deHoy = registros.filter(function (r) { return getDiaOperativo(r, horaCorte) === diaOp; });
    pintarPromedio('s-tiempo-patio', promedioMinutos(deHoy, 'patio'));
    pintarPromedio('s-tiempo-muelle', promedioMinutos(deHoy, 'muelle'));

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
    // lo que cada vehículo lleva EN MUELLE contra la meta de SU
    // tipología. Un vehículo puede ir bien en una y disparado en la
    // otra.
    pintarAlertaMuelle(enMuelle);

    // Grilla de muelles
    var ocupacion = getMuellesOcupacion(enMuelle, numMuelles);
    var htmlGrid = '';
    for (var n = 1; n <= numMuelles; n++) {
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
                      renderAvanceSoloLectura(rec, false) +
                      '<div style="margin-top:6px;display:flex;gap:4px;">' +
                        '<button class="btn btn-sm btn-primary" data-editar="' + rec.id + '">Mover</button>' +
                        '<button class="btn btn-sm" data-observacion="' + rec.id + '" title="Agregar observación"><i class="ti ti-message-plus"></i></button>' +
                        '<button class="btn btn-sm btn-danger" data-salida="' + rec.id + '"' + attrsBotonSalida(rec) + '>Salida</button>' +
                      '</div>'
                    : '<div class="muelle-card-empty">Disponible</div>') +
            '</div></div>';
    }
    document.getElementById('muelles-grid').innerHTML = htmlGrid;

    // Tabla de patio
    var tbody = document.getElementById('dash-table');
    var enPatioOrd = ordenarPorPrioridad(enPatio, configBodega);
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
}

/* =========================================================
   ALERTAS DE MUELLE (meta por tipología)

   La segunda alerta del tablero, separada de la de patio a
   propósito: aquella avisa de la cola de afuera contra el límite
   general de la bodega; esta avisa del vehículo que YA ESTÁ
   operando y se pasó de las horas que el administrador le fijó a
   su tipología en Configuración.
   ========================================================= */

function nivelMuelle(r) {
    return nivelContraMeta(
        minutosEnMuelle(r),
        tiemposDe(configBodega, r.tipologia, faseActual(r), modalidadDe(r))
    );
}

/* Cuánto lleva en muelle y contra qué meta. Se muestra siempre que
   haya meta, no solo al pasarse: el operario necesita ver que va
   en 40 de 105 minutos para saber que va bien, no enterarse solo
   cuando ya es tarde.

   Sin meta lo dice en voz alta: un muelle sin cifra se lee como
   "va bien", y lo que pasa es que ese vehículo no tiene tipología
   asignada — que es justo lo que hay que ir a corregir. */
function avisoMetaMuelle(r) {

    var meta = tiemposDe(configBodega, r.tipologia, faseActual(r), modalidadDe(r));
    var min = minutosEnMuelle(r);

    if (!meta) {
        return '<div class="muelle-meta sin-meta"><i class="ti ti-help-circle"></i> ' +
               formatDuration(min) + ' en muelle · sin meta (falta tipología)</div>';
    }

    var nivel = nivelContraMeta(min, meta);
    var icono = nivel === 'alta' ? 'ti-alert-triangle' : nivel === 'media' ? 'ti-clock-exclamation' : 'ti-clock-check';

    return '<div class="muelle-meta ' + nivel + '"><i class="ti ' + icono + '"></i> ' +
           formatDuration(min) + ' de ' + formatDuration(meta.meta) +
           (distingueModalidad(configBodega) ? ' · ' + modalidadDe(r).toLowerCase() : '') +
           (nivel !== 'normal' ? ' · ' + formatDuration(min - meta.meta) + ' por encima' : '') +
           '</div>';
}

function pintarAlertaMuelle(enMuelle) {

    var banner = document.getElementById('alerta-muelle-banner');
    if (!banner) return;

    var fuera = enMuelleFueraDeMeta(enMuelle, configBodega);

    if (!fuera.length) {
        banner.style.display = 'none';
        return;
    }

    banner.style.display = 'flex';
    document.getElementById('alerta-muelle-detalle').textContent =
        fuera.length + ' vehículo(s) pasaron la meta de su tipología en muelle: ' +
        fuera.map(function (r) {
            var p = prioridadDe(r, configBodega);
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
    var p = prioridadDe(r, configBodega);
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
   AVANCE EN SOLO LECTURA (vista del operario)

   El operario NO edita el avance — eso es del supervisor. Pero sí
   necesita verlo: es lo que le permite decirle al supervisor
   "el muelle 3 va en 80% de cargue y le falta la autorización"
   en vez de tener que ir a preguntar. Por eso aquí solo se pinta
   la barra y el estado; no se emite ningún botón ni atributo
   data-avance, para que no haya nada en qué hacer clic.
   ========================================================= */

function claseNivel(nivel) {
    if (nivel === 'ok') return 'avance-estado-ok';
    if (nivel === 'sin-avance') return 'avance-estado-neutro';
    if (nivel === 'espera') return 'avance-estado-espera';
    return 'avance-estado-bloqueo';
}

function renderAvanceSoloLectura(rec, compacto) {
    if (!requiereAvanceCompleto(rec)) {
        return compacto
            ? '<span class="avance-mini-vacio">—</span>'
            : '<div class="avance-box"><span class="avance-label">Sin avance registrado</span></div>';
    }

    var pct = rec.avancePorcentaje || 0;
    var tipo = rec.avanceTipo || rec.tipo || '';
    var claseBadge = tipo === 'Cargue' ? 'badge-cargue' : 'badge-descargue';
    var d = diagnosticoSalida(rec, configBodega);

    // Un vehículo que ya salió no tiene nada pendiente: decirle
    // "faltan 20%" a un registro cerrado solo confunde.
    var abierto = !rec.horaSalida;

    // Cuánto falta para desbloquear la salida. Solo se pinta si
    // subir el porcentaje es lo que la destraba: si ya pasó el
    // mínimo y lo único pendiente es la firma del supervisor,
    // `faltante` viene en null y aquí no se muestra ninguna cifra
    // (decir "faltan 0%" confundiría más de lo que ayuda).
    var falta = (abierto && !d.puedeSalir && d.faltante)
        ? d.faltante + '% para el mínimo del ' + d.minimo + '%'
        : '';

    if (compacto) {
        return '<div class="avance-mini">' +
            '<div class="avance-mini-top"><span class="badge ' + claseBadge + '">' + tipo + '</span>' +
            '<span class="avance-mini-pct">' + pct + '%</span></div>' +
            '<div class="avance-bar"><div class="avance-bar-fill" style="width:' + pct + '%"></div></div>' +
            (falta ? '<div class="avance-mini-falta" title="' + d.titulo + '">Faltan ' + falta + '</div>' : '') +
            (abierto && !falta ? '<div class="avance-mini-estado ' + claseNivel(d.nivel) + '">' + d.titulo + '</div>' : '') +
        '</div>';
    }

    return '<div class="avance-box">' +
        '<div class="avance-info">' +
            '<span class="badge ' + claseBadge + '">' + tipo + '</span>' +
            '<span class="avance-pct">' + pct + '%</span>' +
        '</div>' +
        '<div class="avance-bar"><div class="avance-bar-fill" style="width:' + pct + '%"></div></div>' +
        (abierto
            ? '<div class="avance-estado ' + claseNivel(d.nivel) + '">' + d.titulo +
                  (falta ? ' · faltan ' + falta : '') +
              '</div>'
            : '') +
    '</div>';
}


/* =========================================================
   ALERTA DE SALIDA BLOQUEADA

   Toda la regla de negocio (qué mínimo aplica, cuántos puntos
   faltan) vive en diagnosticoSalida(); aquí solo se pinta. Se
   muestra en el modal de salida y en el de detalle, para que el
   operario sepa POR QUÉ no puede despachar el vehículo y QUÉ
   falta, sin tener que ir a preguntarle al supervisor.
   ========================================================= */

/* El botón de salida NUNCA se oculta ni se deshabilita en la
   lista: es el que abre el modal donde se explica el bloqueo. Lo
   que sí lleva es el motivo en el tooltip y un color de aviso,
   para que el operario lo sepa antes de hacer clic. */
function attrsBotonSalida(rec) {
    var d = diagnosticoSalida(rec, configBodega);
    if (d.puedeSalir) return '';
    return ' data-bloqueada="1" title="' + d.titulo +
        (d.faltante ? ' — faltan ' + d.faltante + '% para el ' + d.minimo + '%' : '') + '"';
}

function alertaSalida(rec) {

    var d = diagnosticoSalida(rec, configBodega);

    // Si puede salir y el avance está en regla no hay nada que
    // advertir. El caso 'sin-avance' sí se avisa aunque deje
    // salir: ahí la verificación queda en manos del operario.
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

function badgeEstado(r) {
    // Va antes que "Salió" porque un cancelado también trae hora de
    // salida. La portería no cancela, pero sí tiene que ver cuál se
    // fue sin operar: es el vehículo que no va a volver hoy.
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
    var list = registros.slice();

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

    list = ordenarPorPrioridad(list, configBodega);

    var tbody = document.getElementById('reg-table');

    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="18" class="empty-state">Sin registros con estos filtros.</td></tr>';
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
            '<td>' + renderAvanceSoloLectura(r, true) + '</td>' +
            '<td>' + (r.programado ? 'Sí' : 'No') + '</td>' +
            '<td>' + (r.programado && r.horaProgramacion ? fmtDt(r.horaProgramacion) : '—') + '</td>' +
            '<td>' + (r.servicioTipo || 'Normal') + '</td>' +
            '<td>' + formatDuration(dur.patio) + '</td>' +
            '<td>' + formatDuration(dur.muelle) + '</td>' +
            '<td>' + celdaMotivoPatio(r) + '</td>' +
            '<td>' + (r.operadorEntrada || '—') + '</td>' +
            '<td><div class="td-actions">' +
                (!r.horaSalida ? '<button class="btn btn-sm btn-success" data-salida="' + r.id + '"' + attrsBotonSalida(r) + '><i class="ti ti-logout"></i></button>' : '') +
                '<button class="btn btn-sm" data-editar="' + r.id + '"><i class="ti ti-edit"></i></button>' +
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
    var ocupacion = getMuellesOcupacion(enMuelle, numMuelles);
    var libres = getMuellesLibres(ocupacion, numMuelles, muelleActual);
    var valorPrevio = selectEl.value;

    var html = '';
    for (var n = 1; n <= numMuelles; n++) {
        var esActual = muelleActual != null && String(n) === String(muelleActual);
        if (libres.indexOf(n) !== -1) {
            html += '<option value="' + n + '">' + n + (esActual ? ' (actual)' : '') + '</option>';
        }
    }
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
        wrapper.style.display = 'block'; empresaSelect.style.display = 'none'; empresaText.style.display = 'block'; empresaText.value = clienteBodega();
    } else {
        wrapper.style.display = 'none'; empresaSelect.style.display = 'none'; empresaText.style.display = 'none';
    }
}

/* Los nombres de las tipologías los escribe el administrador a
   mano, así que no pueden ir crudos dentro de un atributo HTML.
   Misma implementación que en los paneles de supervisor, cliente
   y administrador. */
function escapar(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


/* =========================================================
   LA TIPOLOGÍA YA NO SE CAPTURA AQUÍ

   Aquí vivían el desplegable de tipología del formulario de
   entrada y el modal que bloqueaba el registro cuando faltaba.
   Los dos se quitaron: la tipología la asigna el SUPERVISOR, que
   es quien ve el vehículo abierto en el muelle. En la fila de
   entrada, con el camión cerrado y la portería de afán, la
   elección se hacía a ojo — y de ella cuelgan la tarifa y las
   metas de tiempo contra las que después se mide la bodega.

   El dato no se volvió opcional: cambió de momento y de
   responsable. Sin tipología el vehículo NO PUEDE SALIR, y la
   regla vive en diagnosticoSalida() (vehiculos.js), que es la
   misma puerta por la que ya pasaban el avance y la autorización
   del supervisor.
   ========================================================= */

function limpiarForm() {

    ['f-conductor', 'f-placa', 'f-ubicacion', 'f-numeroMuelle', 'f-cedula', 'f-obs', 'f-programado', 'f-servicio-tipo']
        .forEach(function (id) { document.getElementById(id).value = ''; });

    limpiarHora('f-hora-programacion-h', 'f-hora-programacion-m');

    document.getElementById('f-servicio-empresa').value = '';
    document.getElementById('f-servicio-empresa-text').value = clienteBodega();
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

    if (!conductor) { toast('Ingresa ' + rotulo('conductor').toLowerCase(), 'red', 'ti-alert-circle'); return; }

    var errorConductor = errorDeFormato(conductor, formatoCampo(configBodega, 'conductor'), rotulo('conductor'));
    if (errorConductor) { toast(errorConductor, 'red', 'ti-alert-circle'); return; }

    var errorCedula = errorDeFormato(cedula, formatoCampo(configBodega, 'cedula'), rotulo('cedula'));
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

    var activo = registros.find(function (r) { return r.placa === placa && !r.horaSalida; });
    if (activo) { toast('El vehículo ' + placa + ' ya está activo en ' + getDestino(activo), 'amber', 'ti-alert-triangle'); return; }

    var datos = {
        conductor: conductor, placa: placa, horaEntrada: hora,
        programado: programado, horaProgramacion: horaProgramacion,
        ubicacion: ubicacion, numeroMuelle: numeroMuelle, bahia: 'A', canal: canal,
        destino: computeDestino(ubicacion, numeroMuelle, 'A'),
        tipo: tipo, cedula: cedula, obs: obs,
        servicioTipo: servicioTipo || 'Normal', servicioEmpresa: servicioEmpresa,
        // Nace sin tipología: la asigna el supervisor. Los dos campos
        // van igual, vacíos, porque el resto de la aplicación los lee
        // —tablas, ficha, exportación— y un registro sin la clave
        // definida obligaría a cada lector a distinguir entre "falta
        // el dato" y "falta el campo".
        tipologia: '',
        tipologiaNombre: ''
    };

    setSyncStatus('syncing');

    try {
        await crearRegistro(OPERACION, datos, perfilActual.nombre);
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

/* Pinta la alerta y habilita o bloquea el botón de confirmar.
   Se llama al abrir el modal y otra vez en cada snapshot, para
   que si el supervisor sube el porcentaje o autoriza la salida
   mientras el modal está abierto, el botón se destrabe solo sin
   que el operario tenga que cerrar y volver a entrar. */
function pintarEstadoSalida(rec) {

    var d = diagnosticoSalida(rec, configBodega);

    document.getElementById('modal-salida-info').innerHTML =
        '<strong>' + rec.placa + '</strong> — ' + rec.conductor + alertaSalida(rec);

    // El bloqueo no se deja solo para el momento de confirmar: el
    // botón queda inhabilitado desde que se abre el modal, para que
    // no se llene la hora y las observaciones a cambio de un toast
    // de error. confirmarSalida() vuelve a validar de todos modos.
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

async function confirmarSalida() {
    var rec = registros.find(function (r) { return r.id === selectedId; });
    if (!rec) return;

    var diag = diagnosticoSalida(rec, configBodega);
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
   MODAL: OBSERVACIÓN RÁPIDA

   Anotar algo no debería obligar a pasar por "Mover": ese modal
   pide ubicación y canal, y para dejar una nota había que volver a
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

    // El textarea arranca vacío a propósito: se agrega una
    // observación nueva, no se edita la anterior (que queda en el
    // historial y se puede consultar en Detalle).
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

    /* La ficha compartida, la misma que usa la portería de J4 y que
       ven el supervisor y el administrador. Este modal armaba a mano
       siete filas y se quedaba sin tipología, sin los tiempos por
       ubicación y sin cómo vino la mercancía.

       Ver el encabezado de detalleVehiculo.js. */
    document.getElementById('modal-detalle-body').innerHTML =
        fichaVehiculo(rec, {
            etiquetas: etiquetasExport(),
            distingueModalidad: distingueModalidad(configBodega),
            mostrarOperarios: true,

            // El avance va aparte, aquí abajo: la barra con el
            // diagnóstico de salida es lo que el operario necesita
            // para decidir si despacha, y dos cifras del mismo dato
            // en la misma pantalla solo generan duda.
            mostrarAvance: false
        }) +
        '<div class="detail-section-title">Avance de la operación</div>' + renderAvanceSoloLectura(rec, false) +
        (!rec.horaSalida ? alertaSalida(rec) : '') +
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
    var ok = exportarExcel(registros, getStateLabel, 'inlotrans_' + OPERACION + '_' + today() + '.xlsx', 'Registros ' + OPERACION, etiquetasExport());
    if (!ok) toast('No hay registros para exportar', 'amber', 'ti-alert-circle');
}

function exportarHoy() {
    var hoy = today();
    var deHoy = registros.filter(function (r) { return (r.fecha || (r.horaEntrada || '').slice(0, 10)) === hoy; });
    var ok = exportarExcel(deHoy, getStateLabel, 'inlotrans_' + OPERACION + '_hoy_' + hoy + '.xlsx', 'Hoy', etiquetasExport());
    if (!ok) toast('No hay registros de hoy para exportar', 'amber', 'ti-alert-circle');
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

        var btnAgregarOp = e.target.closest('[data-agregar-operacion]');
        if (btnAgregarOp) { confirmarAgregarOperacion(btnAgregarOp.getAttribute('data-agregar-operacion')); return; }

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

    unsubscribeRegistros = suscribirseARegistros(OPERACION, function (data, error) {
        if (error) { setSyncStatus('error'); return; }
        registros = data;
        renderTodo();
        refrescarModalSalida();
        if (document.getElementById('muelle-options').style.display !== 'none') {
            poblarSelectMuelles(document.getElementById('f-numeroMuelle'), null);
        }
    });

    // En vivo y no una sola lectura: si el administrador crea una
    // tipología con la portería abierta, el desplegable la ofrece
    // sin que el operario tenga que recargar la página.
    unsubscribeConfig = suscribirseAConfig(OPERACION, function (config, error) {
        if (error) {
            console.error('No se pudo cargar la configuración de ' + OPERACION + ':', error);
            toast('No se pudo cargar la lista de tipologías', 'amber', 'ti-alert-triangle');
            return;
        }
        configBodega = config;

        // El tablero de muelles y el corte del turno salen de aquí.
        // Un cambio del administrador reorganiza la portería sin que
        // el operario tenga que recargar.
        numMuelles = config.muelles || MUELLES_POR_DEFECTO;
        horaCorte = config.horaCorte != null ? config.horaCorte : HORA_CORTE_POR_DEFECTO;

        pintarTituloMuelles();
        pintarEtiquetasCampos();

        // El nombre del cliente se escribe en el campo de empresa del
        // servicio de insumos: si cambió, el formulario abierto tiene
        // que reflejarlo antes de que se registre la próxima entrada.
        cambiarServicioTipo();
        renderTodo();
    });

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

    // Exportar
    document.getElementById('btn-export-todos').addEventListener('click', exportarTodos);
    document.getElementById('btn-export-hoy').addEventListener('click', exportarHoy);

    // Sidebar móvil
    document.getElementById('btn-menu-toggle').addEventListener('click', toggleSidebar);
    document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);

    document.getElementById('btn-cerrar-sesion').addEventListener('click', salir);

    wireDelegatedClicks();

    syncTipoUI();
    cambiarServicioTipo();
    renderTodo();
}


protegerPagina({
    rolesPermitidos: ["operario"],
    operacion: OPERACION
}).then(iniciarPagina).catch(function (error) {
    console.warn('Acceso bloqueado:', error.message);
});

window.addEventListener('beforeunload', function () {
    if (unsubscribeRegistros) unsubscribeRegistros();
    if (unsubscribeConfig) unsubscribeConfig();
});
