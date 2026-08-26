/* =========================================================
   INLOTRANS
   Guardia de páginas

   Cada página de operación (operador/supervisor/clientes)
   debe llamar protegerPagina() ANTES de mostrar cualquier
   contenido o tocar Firestore.

   Uso típico al inicio de operador.js:

       import { protegerPagina } from "../../../shared/core/guard.js";

       protegerPagina({
           rolesPermitidos: ["operario"],
           operacion: "J4"
       }).then(function (perfil) {
           // perfil.nombre, perfil.rol, perfil.operacion
           iniciarPagina(perfil);
       }).catch(function () {
           // ya fue redirigido a index.html, no hacer nada más
       });

   Nota de rutas: asume que toda página de rol vive en
   operaciones/operacion{X}/{rol}/index.html — es decir,
   3 carpetas de profundidad respecto a la raíz del proyecto.
   Si esa profundidad cambia, ajustar RUTA_LOGIN abajo.
   ========================================================= */

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

import { auth } from "./firebase.js";
import { obtenerPerfil } from "./auth.js";
import { obtenerSesion, guardarSesion, cerrarSesionLocal } from "./session.js";

const RUTA_LOGIN = "../../../index.html";


export function protegerPagina(opciones) {

    opciones = opciones || {};

    var rolesPermitidos = opciones.rolesPermitidos || null;
    var operacion = opciones.operacion || null;

    return new Promise(function (resolve, reject) {

        onAuthStateChanged(auth, async function (user) {

            if (!user) {
                cerrarSesionLocal();
                redirigirALogin();
                reject(new Error("NO_AUTENTICADO"));
                return;
            }

            var perfil = obtenerSesion();

            // Si no hay sesión local guardada, o pertenece a otro usuario
            // (ej. alguien cerró sesión de un usuario y entró con otro),
            // se vuelve a consultar el perfil real en Firestore.
            if (!perfil || perfil.uid !== user.uid) {

                perfil = await obtenerPerfil(user.uid);

                if (perfil) {
                    perfil.uid = user.uid;
                    guardarSesion(perfil, true);
                }
            }

            if (!perfil || perfil.activo === false) {
                cerrarSesionLocal();
                redirigirALogin();
                reject(new Error("PERFIL_INVALIDO"));
                return;
            }

            if (rolesPermitidos && rolesPermitidos.indexOf(perfil.rol) === -1) {
                redirigirALogin();
                reject(new Error("ROL_NO_AUTORIZADO"));
                return;
            }

            // El administrador puede entrar a cualquier operación;
            // los demás roles solo a la suya.
            if (
                operacion &&
                perfil.rol !== "administrador" &&
                (perfil.operacion || "").toLowerCase() !== operacion.toLowerCase()
            ) {
                redirigirALogin();
                reject(new Error("OPERACION_NO_AUTORIZADA"));
                return;
            }

            resolve(perfil);
        });
    });
}


function redirigirALogin() {
    window.location.href = RUTA_LOGIN;
}