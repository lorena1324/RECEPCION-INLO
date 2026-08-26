/* =========================================================
   INLOTRANS
   Autenticación

   Aquí vive la lógica real de:
     - iniciar sesión
     - obtener el perfil del usuario (rol / operación / cliente)
     - recuperar contraseña
     - traducir errores de Firebase a mensajes legibles
   ========================================================= */

import {
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

import {
    doc,
    getDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { auth, db } from "./firebase.js";


/* =========================================================
   OBTENER PERFIL DESDE FIRESTORE

   Se espera un documento en la colección "usuarios"
   con ID = uid del usuario de Authentication.

   Estructura esperada:
   {
       nombre: "...",
       rol: "operario" | "supervisor" | "cliente" | "administrador",
       operacion: "J3" | "J4" | "B9" | null,
       cliente: "..." | null,
       activo: true
   }
   ========================================================= */

export async function obtenerPerfil(uid) {

    const ref = doc(db, "usuarios", uid);

    const snap = await getDoc(ref);

    return snap.exists() ? snap.data() : null;
}


/* =========================================================
   INICIAR SESIÓN

   Lanza un Error con un `code` (errores de Firebase) o un
   `message` propio ("PERFIL_NO_ENCONTRADO" / "USUARIO_INACTIVO")
   que login.js traduce con mapearErrorAuth().
   ========================================================= */

export async function iniciarSesion(email, password) {

    const credencial = await signInWithEmailAndPassword(
        auth,
        email,
        password
    );

    const perfil = await obtenerPerfil(credencial.user.uid);

    if (!perfil) {
        await signOut(auth);
        throw new Error("PERFIL_NO_ENCONTRADO");
    }

    if (perfil.activo === false) {
        await signOut(auth);
        throw new Error("USUARIO_INACTIVO");
    }

    return {
        uid: credencial.user.uid,
        ...perfil
    };
}


/* =========================================================
   RECUPERAR CONTRASEÑA
   ========================================================= */

export async function recuperarContrasena(email) {

    await sendPasswordResetEmail(auth, email);
}


/* =========================================================
   CERRAR SESIÓN
   ========================================================= */

export async function cerrarSesionFirebase() {

    await signOut(auth);
}


/* =========================================================
   MAPEO DE ERRORES A MENSAJES EN ESPAÑOL
   ========================================================= */

export function mapearErrorAuth(error) {

    const code = error?.code || "";

    switch (code) {

        case "auth/invalid-email":
            return "El correo electrónico no es válido.";

        case "auth/user-disabled":
            return "Esta cuenta está deshabilitada. Contacta al administrador.";

        case "auth/user-not-found":
        case "auth/wrong-password":
        case "auth/invalid-credential":
            return "Correo o contraseña incorrectos.";

        case "auth/too-many-requests":
            return "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo.";

        case "auth/network-request-failed":
            return "No hay conexión a internet. Verifica tu red e intenta de nuevo.";

        default:
            break;
    }

    if (error?.message === "PERFIL_NO_ENCONTRADO") {
        return "Tu usuario no tiene un perfil configurado en el sistema. Contacta al administrador.";
    }

    if (error?.message === "USUARIO_INACTIVO") {
        return "Tu cuenta está inactiva. Contacta al administrador.";
    }

    return "No fue posible iniciar sesión. Inténtalo nuevamente.";
}