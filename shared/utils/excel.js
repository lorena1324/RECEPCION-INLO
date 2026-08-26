/* =========================================================
   INLOTRANS
   Exportación a Excel

   Extraído de bodega-J4.html, sin cambios de lógica.

   Requiere que la página que lo use incluya la librería SheetJS
   por <script>, igual que ya hacías:

       <script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>

   Este módulo asume que `window.XLSX` ya existe cuando se
   llama a exportarExcel() — por eso el <script> de arriba debe
   ir ANTES del <script type="module"> de la página.
   ========================================================= */

import { fmtDt, formatDuration, duracion, today } from "./tiempos.js";
import { getHistorial, getLocationDurations, tituloHistorial } from "../services/eventos.js";

const ANCHOS_COLUMNAS = [14, 22, 16, 12, 10, 10, 10, 10, 10, 16, 18, 18, 18, 18, 18, 18, 16, 12, 18, 18, 18, 38, 12, 12];


/*
    getStateLabel se pasa como parámetro porque depende de la
    definición de estados de cada operación (hoy es la misma
    lógica en J3/J4, pero se deja inyectable por si una
    operación futura define estados distintos).
*/
export function buildExcelData(registros, getStateLabel) {

    return registros.map(function (r) {

        var duraciones = getLocationDurations(r);

        return {
            'Placa': r.placa,
            'Conductor': r.conductor,
            'Cédula': r.cedula || '',
            'Ubicación': r.ubicacion,
            'Muelle': r.numeroMuelle || '',
            'Bahía': r.bahia || '',
            'Tipo': r.tipo,
            'Canal': r.canal || '',
            'Programado': r.programado ? 'Sí' : 'No',
            'Hora programación': fmtDt(r.horaProgramacion),
            'Servicio': r.servicioTipo ? (r.servicioTipo + (r.servicioEmpresa ? ' / ' + r.servicioEmpresa : '')) : 'Normal',
            'Duración patio': formatDuration(duraciones.patio),
            'Duración muelle': formatDuration(duraciones.muelle),
            'Hora entrada': fmtDt(r.horaEntrada),
            'Operador entrada': r.operadorEntrada || '',
            'Hora salida': fmtDt(r.horaSalida),
            'Operador salida': r.operadorSalida || '',
            'Tiempo en patio': duracion(r.horaEntrada, r.horaSalida),
            'Estado': getStateLabel(r),
            'Obs. entrada': r.obs || '',
            'Obs. ubicación': r.obsUbicacion || '',
            'Obs. salida': r.obsSalida || '',
            'Historial completo': getHistorial(r).map(function (h) {
                return fmtDt(h.fecha) + ' (' + (h.operador || '—') + '): ' + tituloHistorial(h) + (h.texto ? ' — ' + h.texto : '');
            }).join(' | '),
            'Fecha': r.fecha
        };
    });
}

export function exportarExcel(registros, getStateLabel, nombreArchivo, nombreHoja) {

    if (!registros.length) {
        return false;
    }

    var ws = XLSX.utils.json_to_sheet(buildExcelData(registros, getStateLabel));
    ws['!cols'] = ANCHOS_COLUMNAS.map(function (w) { return { wch: w }; });

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, nombreHoja || 'Registros');
    XLSX.writeFile(wb, nombreArchivo || ('inlotrans_' + today() + '.xlsx'));

    return true;
}