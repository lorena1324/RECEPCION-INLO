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
import { modalidadDe } from "../services/config.js";

/* Un ancho por columna, en el mismo orden que las arma
   buildExcelData(). Al agregar una columna hay que agregar aquí su
   ancho: si la lista queda corta, las últimas salen con el ancho
   por defecto de SheetJS y la hoja se lee torcida. */
const ANCHOS_COLUMNAS = [14, 22, 16, 18, 16, 12, 10, 10, 10, 10, 10, 16, 18, 18, 18, 18, 18, 18, 16, 12, 18, 18, 18, 38, 12, 12, 14, 30];


/*
    getStateLabel se pasa como parámetro porque depende de la
    definición de estados de cada operación (hoy es la misma
    lógica en J3/J4, pero se deja inyectable por si una
    operación futura define estados distintos).

    `etiquetas` trae cómo llama esta bodega a los dos campos
    libres del registro. Sin él la hoja saldría con "Conductor" y
    "Cédula" en una operación que anota proveedores y números de
    cita, y quien reciba el archivo leería mal dos columnas
    enteras sin manera de notarlo.
*/
export function buildExcelData(registros, getStateLabel, etiquetas) {

    const rotuloConductor = (etiquetas && etiquetas.conductor) || 'Conductor';
    const rotuloCedula = (etiquetas && etiquetas.cedula) || 'Cédula';

    return registros.map(function (r) {

        var duraciones = getLocationDurations(r);

        var fila = {
            'Placa': r.placa
        };

        fila[rotuloConductor] = r.conductor;
        fila[rotuloCedula] = r.cedula || '';

        return Object.assign(fila, {

            /* La tipología y cómo vino la mercancía. Son los dos
               datos de los que cuelga la meta de tiempo en muelle, y
               ninguno de los dos salía en la hoja: quien recibía el
               archivo veía "Duración muelle: 3h 10min" sin nada
               contra qué compararlo, y la modalidad solo se podía
               deducir leyendo la columna de historial completo, que
               es un párrafo por vehículo.

               La modalidad se escribe siempre que el registro la
               traiga; sin marcar se deja en blanco en vez de poner
               "Arrumado", porque en la hoja no hay forma de
               distinguir lo confirmado de lo supuesto y una columna
               llena de "Arrumado" inventados se leería como dato
               medido. Esa distinción sí está en la ficha del
               vehículo. */
            'Tipología': r.tipologiaNombre || '',
            'Mercancía': r.modalidad ? modalidadDe(r) : '',

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
            'Fecha': r.fecha,

            // Una columna para cada mitad: si el vehículo se canceló
            // y, cuando se canceló, por qué. Van al final para no
            // correr las columnas de las hojas que ya se usan.
            'Cancelado': r.cancelado ? (r.cancelacion && r.cancelacion.llego === false ? 'Sí — no llegó' : 'Sí') : 'No',
            'Motivo cancelación': (r.cancelacion && r.cancelacion.motivo) || ''
        });
    });
}

export function exportarExcel(registros, getStateLabel, nombreArchivo, nombreHoja, etiquetas) {

    if (!registros.length) {
        return false;
    }

    var ws = XLSX.utils.json_to_sheet(buildExcelData(registros, getStateLabel, etiquetas));
    ws['!cols'] = ANCHOS_COLUMNAS.map(function (w) { return { wch: w }; });

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, nombreHoja || 'Registros');
    XLSX.writeFile(wb, nombreArchivo || ('inlotrans_' + today() + '.xlsx'));

    return true;
}