/* =========================================================
   INLOTRANS
   SheetJS (Excel) a pedido

   La librería pesa casi 1 MB y antes cada panel la descargaba al
   abrir, aunque nadie exportara: la página no arrancaba hasta
   bajarla. Ahora se descarga la primera vez que alguien pulsa
   "Exportar" y queda en memoria para las siguientes.

       conXLSX(function () { ...usa window.XLSX... });
   ========================================================= */

const URL_XLSX = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";

let cargando = null;

export function cargarXLSX() {

    if (window.XLSX) return Promise.resolve(window.XLSX);

    if (!cargando) {
        cargando = new Promise(function (resolve, reject) {
            const s = document.createElement("script");
            s.src = URL_XLSX;
            s.async = true;
            s.onload = function () { window.XLSX ? resolve(window.XLSX) : reject(new Error("XLSX no cargó")); };
            s.onerror = function () { cargando = null; s.remove(); reject(new Error("No se pudo descargar la librería de Excel")); };
            document.head.appendChild(s);
        });
    }
    return cargando;
}

/* Corre `fn` cuando la librería ya está. Mientras baja, el cursor
   queda en espera; si no hay conexión, se avisa en vez de no hacer
   nada. */
export function conXLSX(fn) {
    const cuerpo = document.body;
    const antes = cuerpo.style.cursor;
    if (!window.XLSX) cuerpo.style.cursor = "progress";
    return cargarXLSX()
        .then(function () {
            cuerpo.style.cursor = antes;
            return fn();
        }, function (error) {
            cuerpo.style.cursor = antes;
            console.error(error);
            alert("No se pudo preparar el archivo de Excel. Revisa la conexión a internet e inténtalo de nuevo.");
        });
}
