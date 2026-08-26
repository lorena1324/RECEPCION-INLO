/* =========================================================
   INLOTRANS — Operación J3 — Operador

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

import {
    crearRegistro,
    suscribirseARegistros,
    actualizarUbicacion,
    registrarSalida,
    eliminarRegistro as eliminarRegistroFirestore,
    getMuellesOcupacion,
    getMuellesLibres,
    getRegistrosEnMuelle,
    getRegistrosEnPatio
} from "../../../shared/services/vehiculos.js";

import {
    getDestino,
    getHistorial,
    getLocationDurations,
    minutosEsperando,
    ordenarPorPrioridad,
    tituloHistorial
} from "../../../shared/services/eventos.js";

import { nowLocal, today, fmtDt, formatDuration, fechaDentroDeRango, minutosEnPatio } from "../../../shared/utils/tiempos.js";
import { exportarExcel } from "../../../shared/utils/excel.js";

const OPERACION = "J3";
const NUM_MUELLES = 8;

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
    var ocupacion = getMuellesOcupacion(enMuelle, NUM_MUELLES);
    var htmlGrid = '';
    for (var n = 1; n <= NUM_MUELLES; n++) {
        var rec = ocupacion[n];
        htmlGrid += '<div class="muelle-card ' + (rec ? 'ocupado' : 'libre') + '">' +
            '<div class="muelle-card-top">' +
                '<span class="muelle-card-num">Muelle ' + n + '</span>' +
                '<span class="muelle-card-status ' + (rec ? 'ocupado' : 'libre') + '">' + (rec ? 'OCUPADO' : 'LIBRE') + '</span>' +
            '</div>' +
            '<div class="muelle-card-body">' +
                (rec
                    ? '<div class="muelle-card-placa">' + rec.placa + '</div><div>' + rec.conductor + '</div>' +
                      '<div style="margin-top:6px;display:flex;gap:4px;">' +
                        '<button class="btn btn-sm btn-primary" data-editar="' + rec.id + '">Mover</button>' +
                        '<button class="btn btn-sm btn-danger" data-salida="' + rec.id + '">Salida</button>' +
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
        tbody.innerHTML = '<tr><td colspan="16" class="empty-state">Sin registros con estos filtros.</td></tr>';
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
            '<td>' + (!r.horaSalida ? '<span class="badge badge-en-patio">Activo</span>' : '<span class="badge badge-salio">Salió</span>') + '</td>' +
            '<td>' + (r.programado || 'No') + '</td>' +
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
    var ocupacion = getMuellesOcupacion(enMuelle, NUM_MUELLES);
    var libres = getMuellesLibres(ocupacion, NUM_MUELLES, muelleActual);
    var valorPrevio = selectEl.value;

    var html = '';
    for (var n = 1; n <= NUM_MUELLES; n++) {
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
        wrapper.style.display = 'block'; empresaSelect.style.display = 'none'; empresaText.style.display = 'block'; empresaText.value = 'Pepsico';
    } else {
        wrapper.style.display = 'none'; empresaSelect.style.display = 'none'; empresaText.style.display = 'none';
    }
}

function limpiarForm() {

    ['f-conductor', 'f-placa', 'f-ubicacion', 'f-numeroMuelle', 'f-cedula', 'f-obs', 'f-programado', 'f-hora-programacion', 'f-servicio-tipo']
        .forEach(function (id) { document.getElementById(id).value = ''; });

    document.getElementById('f-servicio-empresa').value = '';
    document.getElementById('f-servicio-empresa-text').value = 'Pepsico';
    document.getElementById('programacion-wrapper').style.display = 'none';
    document.getElementById('servicio-empresa-wrapper').style.display = 'none';
    document.getElementById('f-canal').value = 'Sin canal';
    document.getElementById('f-hora').value = nowLocal();
    document.getElementById('muelle-options').style.display = 'none';

    document.querySelector('input[name=tipo][value=Cargue]').checked = true;
    document.querySelector('input[name=tipo][value=Descargue]').checked = false;

    syncTipoUI();
    cambiarServicioTipo();
}

async function registrarEntrada() {

    var conductor = document.getElementById('f-conductor').value.trim();
    var placa = document.getElementById('f-placa').value.trim().toUpperCase();
    var hora = document.getElementById('f-hora').value;
    var ubicacion = document.getElementById('f-ubicacion').value;
    var numeroMuelle = document.getElementById('f-numeroMuelle').value;
    var canal = document.getElementById('f-canal').value;
    var tipo = getTipoSeleccionado();
    var programado = document.getElementById('f-programado').value;
    var horaProgramacionInput = document.getElementById('f-hora-programacion').value;
    var horaProgramacion = horaProgramacionInput ? (today() + 'T' + horaProgramacionInput) : '';
    var servicioTipo = document.getElementById('f-servicio-tipo').value;
    var servicioEmpresa = servicioTipo === 'Reciclaje' ? document.getElementById('f-servicio-empresa').value
        : servicioTipo === 'Insumos' ? document.getElementById('f-servicio-empresa-text').value : '';
    var cedula = document.getElementById('f-cedula').value.trim();
    var obs = document.getElementById('f-obs').value.trim();

    if (!conductor) { toast('Ingresa el nombre del conductor', 'red', 'ti-alert-circle'); return; }
    if (!placa) { toast('Ingresa la placa del vehículo', 'red', 'ti-alert-circle'); return; }
    if (!hora) { toast('Selecciona la hora de ingreso', 'red', 'ti-alert-circle'); return; }
    if (!fechaDentroDeRango(hora)) { toast('La fecha de ingreso no puede ser futura ni anterior a ayer', 'red', 'ti-alert-circle'); return; }
    if (!ubicacion) { toast('Ingresa la ubicación', 'red', 'ti-alert-circle'); return; }
    if (ubicacion === 'Muelle' && !numeroMuelle) { toast('No hay muelles libres para asignar en este momento', 'red', 'ti-alert-circle'); return; }
    if (!tipo) { toast('Selecciona al menos un tipo de operación', 'red', 'ti-alert-circle'); return; }
    if (!programado) { toast('Selecciona si el vehículo está programado o no', 'red', 'ti-alert-circle'); return; }
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

function openModalSalida(id) {
    selectedId = id;
    var rec = registros.find(function (r) { return r.id === id; });
    if (!rec) return;
    document.getElementById('modal-salida-info').innerHTML = '<strong>' + rec.placa + '</strong> — ' + rec.conductor;
    document.getElementById('m-hora-salida').value = nowLocal();
    document.getElementById('m-obs-salida').value = '';
    document.getElementById('modal-salida').classList.add('open');
}

async function confirmarSalida() {
    var rec = registros.find(function (r) { return r.id === selectedId; });
    if (!rec) return;

    var horaSalida = document.getElementById('m-hora-salida').value;
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
    document.getElementById('modal-editar').classList.add('open');
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
    var ok = exportarExcel(registros, getStateLabel, 'inlotrans_' + OPERACION + '_' + today() + '.xlsx', 'Registros ' + OPERACION);
    if (!ok) toast('No hay registros para exportar', 'amber', 'ti-alert-circle');
}

function exportarHoy() {
    var hoy = today();
    var deHoy = registros.filter(function (r) { return (r.fecha || (r.horaEntrada || '').slice(0, 10)) === hoy; });
    var ok = exportarExcel(deHoy, getStateLabel, 'inlotrans_' + OPERACION + '_hoy_' + hoy + '.xlsx', 'Hoy');
    if (!ok) toast('No hay registros de hoy para exportar', 'amber', 'ti-alert-circle');
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

    document.getElementById('f-hora').value = nowLocal();
    var ayer = new Date(today() + 'T00:00:00');
    ayer.setDate(ayer.getDate() - 1);
    document.getElementById('f-hora').min = ayer.toISOString().slice(0, 10) + 'T00:00';
    document.getElementById('f-hora').max = today() + 'T23:59';

    unsubscribeRegistros = suscribirseARegistros(OPERACION, function (data, error) {
        if (error) { setSyncStatus('error'); return; }
        registros = data;
        renderTodo();
        if (document.getElementById('muelle-options').style.display !== 'none') {
            poblarSelectMuelles(document.getElementById('f-numeroMuelle'), null);
        }
    });

    // Eventos del formulario
    document.getElementById('f-ubicacion').addEventListener('change', cambiarUbicacion);
    document.getElementById('f-programado').addEventListener('change', cambiarProgramado);
    document.getElementById('f-servicio-tipo').addEventListener('change', cambiarServicioTipo);
    document.querySelectorAll('input[name=tipo]').forEach(function (chk) { chk.addEventListener('change', syncTipoUI); });
    document.getElementById('btn-limpiar').addEventListener('click', limpiarForm);
    document.getElementById('btn-registrar').addEventListener('click', registrarEntrada);

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
});