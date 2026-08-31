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
    eliminarRegistro as eliminarRegistroFirestore,
    getMuellesOcupacion,
    getMuellesLibres,
    getRegistrosEnMuelle,
    getRegistrosEnPatio,
    puedeRegistrarSalida,
    requiereAvanceCompleto,
    avanceCompleto,
    agregarOperacionFaltante,
    actualizarAvance,
    avanzarAFaseCargue,
    autorizarSalidaAnticipada,
    puedeAutorizarSalidaAnticipada
} from "../shared/services/vehiculos.js";

import {
    getDestino,
    getHistorial,
    getLocationDurations,
    minutosEsperando,
    ordenarPorPrioridad,
    tituloHistorial,
    nivelPrioridad,
    getDiaOperativo,
    diaConMasMovimiento
} from "../shared/services/eventos.js";

import { nowLocal, today, fmtDt, formatDuration, fechaDentroDeRango, minutosEnPatio, todayOperativo, diaOperativo } from "../shared/utils/tiempos.js";
import { exportarExcel } from "../shared/utils/excel.js";

/* Configuración por bodega. El admin no está atado a una sola
   operación: el selector del topbar cambia `operacionActual` y
   todo el panel (muelles, registros, estadísticas) se recarga.
   Al agregar una bodega nueva basta con sumarla a este mapa. */
const OPERACIONES = {
    J3: { nombre: "Pepsico", muelles: 8 },
    J4: { nombre: "Alkosto", muelles: 3 },
    B9: { nombre: "EMMA",    muelles: 4 }
};

const HORA_CORTE = 6;
const STORAGE_OPERACION = "inlotrans_admin_operacion";

// Operación que se está viendo. Se recuerda entre recargas para
// que el admin no tenga que volver a elegirla en cada visita.
let operacionActual = localStorage.getItem(STORAGE_OPERACION) || "J3";
if (!OPERACIONES[operacionActual]) operacionActual = "J3";

function numMuelles() {
    return OPERACIONES[operacionActual].muelles;
}

function clienteActual() {
    return OPERACIONES[operacionActual].nombre;
}
const RUTA_LOGIN = "../index.html";

let registros = [];
let selectedId = null;
let currentFilter = 'todos';
let unsubscribeRegistros = null;
let perfilActual = null;


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

function filtrarSoloDigitos(e) {
    e.target.value = e.target.value.replace(/[^0-9]/g, '');
}

function filtrarSoloLetras(e) {
    e.target.value = e.target.value.replace(/[^A-Za-zÁÉÍÓÚÑÜáéíóúñü\s'.-]/g, '');
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

    var titulos = { dashboard: 'Dashboard', entrada: 'Registrar entrada', registros: 'Registros', estadisticas: 'Estadísticas', exportar: 'Exportar datos' };
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
    renderEstadisticas();
}


/* =========================================================
   DASHBOARD
   ========================================================= */

function renderDashboard() {

    if (!document.getElementById('view-dashboard').classList.contains('active')) return;

    var enPatio = getRegistrosEnPatio(registros);
    var enMuelle = getRegistrosEnMuelle(registros);
    var activos = registros.filter(function (r) { return !r.horaSalida; });

    document.getElementById('s-total').textContent = activos.length;
    document.getElementById('s-patio').textContent = enPatio.length;
    document.getElementById('s-muelle').textContent = enMuelle.length;

    var acumP = 0, countP = 0, acumM = 0, countM = 0;
    registros.forEach(function (r) {
        var dur = getLocationDurations(r);
        if (dur.patio > 0) { acumP += dur.patio; countP++; }
        if (dur.muelle > 0) { acumM += dur.muelle; countM++; }
    });
    document.getElementById('s-tiempo-patio').textContent = countP ? formatDuration(acumP / countP) : '0 min';
    document.getElementById('s-tiempo-muelle').textContent = countM ? formatDuration(acumM / countM) : '0 min';

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

    // Grilla de muelles
    var ocupacion = getMuellesOcupacion(enMuelle, numMuelles());
    var htmlGrid = '';
    for (var n = 1; n <= numMuelles(); n++) {
        var rec = ocupacion[n];
        htmlGrid += '<div class="muelle-card ' + (rec ? 'ocupado' : 'libre') + '">' +
            '<div class="muelle-card-top">' +
                '<span class="muelle-card-num">Muelle ' + n + '</span>' +
                '<span class="muelle-card-status ' + (rec ? 'ocupado' : 'libre') + '">' + (rec ? 'OCUPADO' : 'LIBRE') + '</span>' +
            '</div>' +
            '<div class="muelle-card-body">' +
                (rec
                    ? '<div class="muelle-card-placa">' + rec.placa + '</div><div>' + rec.conductor + '</div>' +
                      renderAvance(rec) +
                      '<div style="margin-top:6px;display:flex;gap:4px;">' +
                        '<button class="btn btn-sm btn-primary" data-editar="' + rec.id + '">Mover</button>' +
                        '<button class="btn btn-sm btn-danger" data-salida="' + rec.id + '">Salida</button>' +
                        '<button class="btn btn-sm" data-detalle="' + rec.id + '"><i class="ti ti-info-circle"></i></button>' +
                      '</div>'
                    : '<div class="muelle-card-empty">Disponible</div>') +
            '</div></div>';
    }
    document.getElementById('muelles-grid').innerHTML = htmlGrid;

    // Tabla de patio
    var tbody = document.getElementById('dash-table');
    var enPatioOrd = ordenarPorPrioridad(enPatio);
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
                    '<button class="btn btn-sm" data-detalle="' + r.id + '"><i class="ti ti-info-circle"></i></button></td>' +
            '</tr>';
        }).join('');
    }
}

function badgePrioridad(r, rank) {
    if (r.horaSalida) return '<span class="badge badge-salio">—</span>';
    var min = minutosEsperando(r);
    var clase = min >= 240 ? 'badge-amber' : (min >= 120 ? 'badge-descargue' : 'badge-en-patio');
    return '<span class="badge ' + clase + '"><i class="ti ti-flag-3"></i> #' + rank + ' · ' + formatDuration(min) + '</span>';
}

function badgeEstado(r) {
    if (r.horaSalida) return '<span class="badge badge-salio">Salió</span>';
    if (!requiereAvanceCompleto(r)) {
        return '<span class="badge badge-amber" title="Sin avance registrado — puede salir sin restricción de %"><i class="ti ti-alert-triangle"></i> Activo</span>';
    }
    return '<span class="badge badge-en-patio">Activo</span>';
}

function celdaMotivoPatio(r) {
    if (r.horaSalida || r.ubicacion !== 'Patio') return '<span style="color:var(--text-3);">—</span>';
    if (!r.obsUbicacion) return '<span style="color:var(--amber-600);cursor:pointer;text-decoration:underline;" data-editar="' + r.id + '">Sin registrar</span>';
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

    list = ordenarPorPrioridad(list);

    var tbody = document.getElementById('reg-table');

    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="17" class="empty-state">Sin registros con estos filtros.</td></tr>';
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
                (!r.horaSalida ? '<button class="btn btn-sm btn-success" data-salida="' + r.id + '"><i class="ti ti-logout"></i></button>' : '') +
                '<button class="btn btn-sm" data-editar="' + r.id + '"><i class="ti ti-edit"></i></button>' +
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
    var ocupacion = getMuellesOcupacion(enMuelle, numMuelles());
    var libres = getMuellesLibres(ocupacion, numMuelles(), muelleActual);
    var valorPrevio = selectEl.value;

    var html = '';
    for (var n = 1; n <= numMuelles(); n++) {
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
        wrapper.style.display = 'block'; empresaSelect.style.display = 'none'; empresaText.style.display = 'block'; empresaText.value = clienteActual();
    } else {
        wrapper.style.display = 'none'; empresaSelect.style.display = 'none'; empresaText.style.display = 'none';
    }
}

function limpiarForm() {

    ['f-conductor', 'f-placa', 'f-ubicacion', 'f-numeroMuelle', 'f-cedula', 'f-obs', 'f-programado', 'f-servicio-tipo']
        .forEach(function (id) { document.getElementById(id).value = ''; });

    limpiarHora('f-hora-programacion-h', 'f-hora-programacion-m');

    document.getElementById('f-servicio-empresa').value = '';
    document.getElementById('f-servicio-empresa-text').value = clienteActual();
    document.getElementById('programacion-wrapper').style.display = 'none';
    document.getElementById('servicio-empresa-wrapper').style.display = 'none';
    document.getElementById('f-canal').value = 'Sin canal';
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
    var horaProgramacionInput = leerHora('f-hora-programacion-h', 'f-hora-programacion-m');
    var horaProgramacion = horaProgramacionInput ? (today() + 'T' + horaProgramacionInput) : '';
    var servicioTipo = document.getElementById('f-servicio-tipo').value;
    var servicioEmpresa = servicioTipo === 'Reciclaje' ? document.getElementById('f-servicio-empresa').value
        : servicioTipo === 'Insumos' ? document.getElementById('f-servicio-empresa-text').value : '';
    var cedula = document.getElementById('f-cedula').value.trim();
    var obs = document.getElementById('f-obs').value.trim();

    if (!conductor) { toast('Ingresa el nombre del conductor', 'red', 'ti-alert-circle'); return; }
    if (!/^[A-Za-zÁÉÍÓÚÑÜáéíóúñü\s'.-]+$/.test(conductor)) { toast('El nombre del conductor solo puede tener letras', 'red', 'ti-alert-circle'); return; }
    if (cedula && !/^[0-9]+$/.test(cedula)) { toast('La cédula solo puede tener números', 'red', 'ti-alert-circle'); return; }
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
        servicioTipo: servicioTipo || 'Normal', servicioEmpresa: servicioEmpresa
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

function mensajeAvanceBloqueado(rec) {
    if (!requiereAvanceCompleto(rec)) {
        return '<div style="margin-top:6px;color:var(--amber-600);font-size:12.5px;"><i class="ti ti-alert-triangle"></i> Este vehículo no tiene avance de cargue/descargue registrado (es un registro anterior a esta función) — puede salir sin restricción de %. Verifica manualmente antes de confirmar.</div>';
    }

    if (puedeRegistrarSalida(rec)) return '';

    var pct = rec.avancePorcentaje || 0;
    var texto;

    if (rec.avanceTipo !== 'Cargue') {
        texto = 'El descargue está en ' + pct + '% — debe llegar al 100% para poder salir, sin excepción.';
    } else if (pct < 75) {
        texto = 'El cargue está en ' + pct + '% — debe llegar mínimo al 75% para que un supervisor pueda autorizar la salida.';
    } else {
        texto = 'El cargue está en ' + pct + '% — un supervisor debe autorizar la salida anticipada (con motivo) antes de poder registrarla.';
    }

    return '<div style="margin-top:6px;color:var(--amber-600);font-size:12.5px;"><i class="ti ti-alert-triangle"></i> ' + texto + '</div>';
}

function openModalSalida(id) {
    selectedId = id;
    var rec = registros.find(function (r) { return r.id === id; });
    if (!rec) return;

    document.getElementById('modal-salida-info').innerHTML = '<strong>' + rec.placa + '</strong> — ' + rec.conductor + mensajeAvanceBloqueado(rec);
    escribirFechaHora('m-fecha-salida', 'm-hora-salida-h', 'm-hora-salida-m', nowLocal());
    document.getElementById('m-obs-salida').value = '';
    document.getElementById('modal-salida').classList.add('open');
}

async function confirmarSalida() {
    var rec = registros.find(function (r) { return r.id === selectedId; });
    if (!rec) return;

    if (!puedeRegistrarSalida(rec)) {
        toast(rec.avanceTipo !== 'Cargue' ? 'El descargue debe llegar al 100% para salir' : 'Falta autorización del supervisor para esta salida', 'red', 'ti-alert-circle');
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
    document.getElementById('e-canal').value = rec.canal || 'Sin canal';
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

    document.getElementById('modal-detalle-body').innerHTML =
        '<div class="detail-row"><span class="detail-lbl">Placa:</span><span class="detail-val">' + rec.placa + '</span></div>' +
        '<div class="detail-row"><span class="detail-lbl">Conductor:</span><span class="detail-val">' + rec.conductor + '</span></div>' +
        '<div class="detail-row"><span class="detail-lbl">Ubicación:</span><span class="detail-val">' + getDestino(rec) + '</span></div>' +
        '<div class="detail-row"><span class="detail-lbl">Ingreso:</span><span class="detail-val">' + fmtDt(rec.horaEntrada) + '</span></div>' +
        '<div class="detail-row"><span class="detail-lbl">Salida:</span><span class="detail-val">' + fmtDt(rec.horaSalida) + '</span></div>' +
        '<div class="detail-row"><span class="detail-lbl">Programado:</span><span class="detail-val">' + (rec.programado && rec.horaProgramacion ? fmtDt(rec.horaProgramacion) : 'No') + '</span></div>' +
        '<div class="detail-row"><span class="detail-lbl">Avance:</span><span class="detail-val">' + textoAvance(rec) + '</span></div>' +
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
    var ok = exportarExcel(registros, getStateLabel, 'inlotrans_' + operacionActual + '_' + today() + '.xlsx', 'Registros ' + operacionActual);
    if (!ok) toast('No hay registros para exportar', 'amber', 'ti-alert-circle');
}

function exportarHoy() {
    var hoy = today();
    var deHoy = registros.filter(function (r) { return (r.fecha || (r.horaEntrada || '').slice(0, 10)) === hoy; });
    var ok = exportarExcel(deHoy, getStateLabel, 'inlotrans_' + operacionActual + '_hoy_' + hoy + '.xlsx', 'Hoy');
    if (!ok) toast('No hay registros de hoy para exportar', 'amber', 'ti-alert-circle');
}


/* =========================================================
   AVANCE DE CARGUE/DESCARGUE  (capacidad de supervisor)

   Mismas reglas de negocio que en supervisor.js: el descargue
   debe llegar al 100% sin excepción; el cargue puede salir
   desde el 75% pero solo con autorización motivada. El admin
   puede hacer las dos cosas sin cambiar de panel.
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
    if (puedeAutorizarSalidaAnticipada(r) && !(r.autorizacionSalida && r.autorizacionSalida.motivo)) {
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
            '<button class="btn btn-sm" data-avance-add="' + r.id + ':5" ' + deshabilitado + '>+5%</button>' +
            '<button class="btn btn-sm" data-avance-add="' + r.id + ':10" ' + deshabilitado + '>+10%</button>' +
        '</div>' + aviso +
        '</div>';
}

// Resumen del avance para el modal de detalle (solo lectura).
function textoAvance(r) {
    if (!requiereAvanceCompleto(r)) return 'Sin registrar (puede salir sin restricción de %)';
    var tipo = getAvanceTipoEfectivo(r) || 'sin definir';
    return tipo + ' — ' + (r.avancePorcentaje || 0) + '%' + (avanceCompleto(r) ? ' (completo)' : '');
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

    operacionActual = nueva;
    localStorage.setItem(STORAGE_OPERACION, nueva);

    if (unsubscribeRegistros) { unsubscribeRegistros(); unsubscribeRegistros = null; }

    registros = [];
    selectedId = null;
    renderTodo();

    pintarEtiquetasOperacion();
    suscribir();

    toast('Viendo operación ' + nueva + ' (' + clienteActual() + ')', 'blue', 'ti-building-warehouse');
}

function pintarEtiquetasOperacion() {
    document.getElementById('op-operacion').textContent = operacionActual + ' · ' + clienteActual();
    document.getElementById('muelles-titulo').textContent = 'Muelles (1 a ' + numMuelles() + ')';
    document.getElementById('selector-operacion').value = operacionActual;
    // El formulario de entrada muestra el cliente de la bodega activa
    cambiarServicioTipo();
}

function suscribir() {
    unsubscribeRegistros = suscribirseARegistros(operacionActual, function (data, error) {
        if (error) { setSyncStatus('error'); return; }
        setSyncStatus('ok');
        registros = data;
        renderTodo();
        if (document.getElementById('muelle-options').style.display !== 'none') {
            poblarSelectMuelles(document.getElementById('f-numeroMuelle'), null);
        }
    });
}


/* =========================================================
   ESTADÍSTICAS (día operativo 6am–6am, igual que supervisor)
   ========================================================= */

var chartDias = null, chartTipos = null, chartCanal = null, chartFranja = null;

function destruirCharts() {
    [chartDias, chartTipos, chartCanal, chartFranja].forEach(function (c) { if (c) c.destroy(); });
    chartDias = chartTipos = chartCanal = chartFranja = null;
}

function renderEstadisticas() {

    if (!document.getElementById('view-estadisticas').classList.contains('active')) return;
    if (typeof Chart === 'undefined') return;

    var total = registros.length;
    var salidas = registros.filter(function (r) { return !!r.horaSalida; }).length;
    var activos = total - salidas;

    document.getElementById('es-total').textContent = total;
    document.getElementById('es-salidas').textContent = salidas;
    document.getElementById('es-activos').textContent = activos;

    var enPatio = getRegistrosEnPatio(registros);
    var enAlerta = enPatio.filter(function (r) { return nivelPrioridad(minutosEsperando(r)) === 'alta'; }).length;
    document.getElementById('es-alerta').textContent = enAlerta;

    var mejor = diaConMasMovimiento(registros, HORA_CORTE);
    document.getElementById('es-mejor-dia').textContent = mejor ? mejor.dia : '—';
    document.getElementById('es-mejor-dia-detalle').textContent = mejor
        ? mejor.total + ' movimientos (' + mejor.entradas + ' entradas · ' + mejor.salidas + ' salidas)'
        : 'Sin datos todavía';

    // Últimos 7 días operativos
    var dias = [];
    for (var i = 6; i >= 0; i--) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        dias.push(diaOperativo(d.toISOString(), HORA_CORTE));
    }

    var entradasPorDia = dias.map(function (dia) {
        return registros.filter(function (r) { return getDiaOperativo(r, HORA_CORTE) === dia; }).length;
    });
    var salidasPorDia = dias.map(function (dia) {
        return registros.filter(function (r) { return r.horaSalida && diaOperativo(r.horaSalida, HORA_CORTE) === dia; }).length;
    });

    destruirCharts();

    chartDias = new Chart(document.getElementById('chart-dias'), {
        type: 'bar',
        data: {
            labels: dias,
            datasets: [
                { label: 'Entradas', data: entradasPorDia, backgroundColor: '#2563eb', borderRadius: 4 },
                { label: 'Salidas', data: salidasPorDia, backgroundColor: '#3B6D11', borderRadius: 4 }
            ]
        },
        options: { plugins: { legend: { position: 'bottom' } }, responsive: true }
    });

    // Tipos de operación
    var cont = { Cargue: 0, Descargue: 0, Ambos: 0 };
    registros.forEach(function (r) { if (cont[r.tipo] !== undefined) cont[r.tipo]++; });

    chartTipos = new Chart(document.getElementById('chart-tipos'), {
        type: 'doughnut',
        data: {
            labels: ['Cargue', 'Descargue', 'Ambos'],
            datasets: [{ data: [cont.Cargue, cont.Descargue, cont.Ambos], backgroundColor: ['#2563eb', '#854F0B', '#3B6D11'] }]
        },
        options: { plugins: { legend: { position: 'bottom' } } }
    });

    // Canal
    var canales = {};
    registros.forEach(function (r) {
        var c = r.canal || 'Sin canal';
        canales[c] = (canales[c] || 0) + 1;
    });

    chartCanal = new Chart(document.getElementById('chart-canal'), {
        type: 'bar',
        data: {
            labels: Object.keys(canales),
            datasets: [{ label: 'Vehículos', data: Object.keys(canales).map(function (k) { return canales[k]; }), backgroundColor: '#2563eb', borderRadius: 4 }]
        },
        options: { plugins: { legend: { display: false } } }
    });

    // Franja horaria del día operativo actual (eje arranca a las 6am)
    var diaHoy = todayOperativo(HORA_CORTE);
    var porHora = new Array(24).fill(0);
    registros.filter(function (r) { return getDiaOperativo(r, HORA_CORTE) === diaHoy; })
        .forEach(function (r) {
            if (!r.horaEntrada) return;
            var h = new Date(r.horaEntrada).getHours();
            if (!isNaN(h)) porHora[h]++;
        });

    var labelsH = [], valoresH = [];
    for (var j = 0; j < 24; j++) {
        var hh = (HORA_CORTE + j) % 24;
        labelsH.push(hh + 'h');
        valoresH.push(porHora[hh]);
    }

    chartFranja = new Chart(document.getElementById('chart-franja'), {
        type: 'bar',
        data: { labels: labelsH, datasets: [{ label: 'Entradas', data: valoresH, backgroundColor: '#854F0B', borderRadius: 4 }] },
        options: { plugins: { legend: { display: false } } }
    });
}


/* =========================================================
   DELEGACIÓN DE EVENTOS (para los botones generados dinámicamente)
   ========================================================= */

function wireDelegatedClicks() {
    document.body.addEventListener('click', function (e) {

        var btnEditar = e.target.closest('[data-editar]');
        if (btnEditar) { openModalEditar(btnEditar.getAttribute('data-editar')); return; }

        var btnSalida = e.target.closest('[data-salida]');
        if (btnSalida) { openModalSalida(btnSalida.getAttribute('data-salida')); return; }

        var btnDetalle = e.target.closest('[data-detalle]');
        if (btnDetalle) { openModalDetalle(btnDetalle.getAttribute('data-detalle')); return; }

        var btnEliminar = e.target.closest('[data-eliminar]');
        if (btnEliminar) { eliminarRegistro(btnEliminar.getAttribute('data-eliminar')); return; }

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

    pintarEtiquetasOperacion();
    suscribir();

    // Eventos del formulario
    document.getElementById('f-ubicacion').addEventListener('change', cambiarUbicacion);
    document.getElementById('f-programado').addEventListener('change', cambiarProgramado);
    document.getElementById('f-servicio-tipo').addEventListener('change', cambiarServicioTipo);
    document.querySelectorAll('input[name=tipo]').forEach(function (chk) { chk.addEventListener('change', syncTipoUI); });
    document.getElementById('btn-limpiar').addEventListener('click', limpiarForm);
    document.getElementById('btn-registrar').addEventListener('click', registrarEntrada);

    // Saneamiento en vivo: conductor solo letras, cédula solo números,
    // horas/minutos nunca fuera de 0-23 / 0-59 mientras se digitan.
    document.getElementById('f-conductor').addEventListener('input', filtrarSoloLetras);
    document.getElementById('f-cedula').addEventListener('input', filtrarSoloDigitos);
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