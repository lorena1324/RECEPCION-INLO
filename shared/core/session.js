/* =========================================================
   INLOTRANS
   Sesión local

   Guarda el perfil (no la contraseña, nunca) para que las
   páginas de operación/supervisor/admin puedan leer
   rápidamente quién está conectado sin volver a golpear
   Firestore en cada carga.

   "Recordar sesión" → localStorage (persiste entre cierres
   de navegador).
   Sin marcar → sessionStorage (se borra al cerrar la pestaña).
   ========================================================= */

const SESSION_KEY = "inlotrans_session";


export function guardarSesion(perfil, recordar) {

    const data = JSON.stringify(perfil);

    if (recordar) {
        localStorage.setItem(SESSION_KEY, data);
        sessionStorage.removeItem(SESSION_KEY);
    } else {
        sessionStorage.setItem(SESSION_KEY, data);
        localStorage.removeItem(SESSION_KEY);
    }
}


export function obtenerSesion() {

    const raw =
        sessionStorage.getItem(SESSION_KEY) ||
        localStorage.getItem(SESSION_KEY);

    return raw ? JSON.parse(raw) : null;
}


export function cerrarSesionLocal() {

    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
}