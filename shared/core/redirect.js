/* =========================================================
   INLOTRANS
   Resolución de ruta según perfil

   Único lugar donde se decide a qué página va cada usuario
   después de iniciar sesión. Si mañana cambian las rutas o
   se agrega una operación nueva, solo se toca aquí.

   Rutas relativas desde index.html (raíz del proyecto).
   ========================================================= */

export function resolverRuta(perfil) {

    const rol = perfil?.rol;
    const operacion = perfil?.operacion; // ej. "J3", "J4", "B9" — se usa tal cual, sin transformar

    if (rol === "administrador") {
        return "admin/dashboard.html";
    }

    if (!operacion) return null;

    const carpetaOperacion = `operaciones/operacion${operacion}`;

    if (rol === "operario") {
        return `${carpetaOperacion}/operador/index.html`;
    }

    if (rol === "supervisor") {
        return `${carpetaOperacion}/supervisor/index.html`;
    }

    if (rol === "cliente") {
        return `${carpetaOperacion}/clientes/index.html`;
    }

    return null;
}