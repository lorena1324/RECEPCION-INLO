/* =========================================================
   INLOTRANS
   Autenticación (Supabase Auth)

   Aquí vive la lógica real de:
     - iniciar sesión
     - obtener el perfil del usuario (rol / operación / cliente)
     - recuperar contraseña
     - traducir errores de Supabase a mensajes legibles
   ========================================================= */

import { supabase } from "./supabase.js";


/* =========================================================
   OBTENER PERFIL

   Tabla "usuarios" (supabase/esquema.sql), con id = id del
   usuario de Supabase Auth:
   {
       nombre: "...",
       rol: "operario" | "supervisor" | "facturacion" | "cliente" | "administrador",
       operacion: "J3" | "J4" | "B9" | null,
       cliente: "..." | null,
       activo: true
   }
   ========================================================= */

export async function obtenerPerfil(uid) {

    const { data, error } = await supabase
        .from("usuarios")
        .select("nombre, rol, operacion, cliente, activo")
        .eq("id", uid)
        .maybeSingle();

    if (error) throw error;

    return data;
}


/* =========================================================
   INICIAR SESIÓN

   Lanza el error de Supabase o un Error propio
   ("PERFIL_NO_ENCONTRADO" / "USUARIO_INACTIVO") que login.js
   traduce con mapearErrorAuth().
   ========================================================= */

export async function iniciarSesion(email, password) {

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) throw error;

    const uid = data.user.id;
    const perfil = await obtenerPerfil(uid);

    if (!perfil) {
        await supabase.auth.signOut();
        throw new Error("PERFIL_NO_ENCONTRADO");
    }

    if (perfil.activo === false) {
        await supabase.auth.signOut();
        throw new Error("USUARIO_INACTIVO");
    }

    return {
        uid: uid,
        ...perfil
    };
}


/* =========================================================
   RECUPERAR CONTRASEÑA

   Supabase manda un enlace que vuelve al login con la sesión
   en modo "recuperación"; ahí login.js pide la contraseña
   nueva (ver escucharRecuperacion).
   ========================================================= */

export async function recuperarContrasena(email) {

    const volverA = window.location.origin + window.location.pathname;

    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: volverA });

    if (error) throw error;
}

export function escucharRecuperacion(alRecuperar) {

    supabase.auth.onAuthStateChange(function (evento) {
        if (evento === "PASSWORD_RECOVERY") alRecuperar();
    });
}

export async function cambiarContrasena(nueva) {

    const { error } = await supabase.auth.updateUser({ password: nueva });

    if (error) throw error;

    await supabase.auth.signOut();
}


/* =========================================================
   CERRAR SESIÓN

   Conserva el nombre que importan todas las páginas.
   ========================================================= */

export async function cerrarSesionFirebase() {

    await supabase.auth.signOut();
}


/* =========================================================
   MAPEO DE ERRORES A MENSAJES EN ESPAÑOL
   ========================================================= */

export function mapearErrorAuth(error) {

    const code = error?.code || "";
    const texto = (error?.message || "").toLowerCase();

    if (error?.message === "PERFIL_NO_ENCONTRADO") {
        return "Tu usuario no tiene un perfil configurado en el sistema. Contacta al administrador.";
    }

    if (error?.message === "USUARIO_INACTIVO") {
        return "Tu cuenta está inactiva. Contacta al administrador.";
    }

    if (code === "invalid_credentials" || texto.includes("invalid login credentials")) {
        return "Correo o contraseña incorrectos.";
    }

    if (code === "email_not_confirmed" || texto.includes("email not confirmed")) {
        return "Tu correo aún no está confirmado. Contacta al administrador.";
    }

    if (code === "user_banned") {
        return "Esta cuenta está deshabilitada. Contacta al administrador.";
    }

    if (code === "weak_password" || texto.includes("password should be")) {
        return "La contraseña es muy corta: usa al menos 6 caracteres.";
    }

    if (code === "validation_failed" || texto.includes("unable to validate email")) {
        return "El correo electrónico no es válido.";
    }

    if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit" || error?.status === 429) {
        return "Demasiados intentos. Espera unos minutos e intenta de nuevo.";
    }

    if (error?.name === "AuthRetryableFetchError" || texto.includes("failed to fetch")) {
        return "No hay conexión a internet. Verifica tu red e intenta de nuevo.";
    }

    return "No fue posible completar la operación. Inténtalo nuevamente.";
}
