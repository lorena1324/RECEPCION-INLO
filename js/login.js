/* =========================================================
   INLOTRANS
   Login UI
   ========================================================= */

"use strict";

import {
    iniciarSesion,
    recuperarContrasena,
    mapearErrorAuth
} from "../shared/core/auth.js";

import { guardarSesion } from "../shared/core/session.js";

import { resolverRuta } from "../shared/core/redirect.js";


/* =========================================================
   ELEMENTOS
   ========================================================= */

const loginForm = document.getElementById("loginForm");

const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");

const emailError = document.getElementById("emailError");
const passwordError = document.getElementById("passwordError");

const loginButton = document.getElementById("loginButton");
const loginMessage = document.getElementById("loginMessage");

const passwordToggle = document.getElementById("passwordToggle");
const eyeOpen = document.getElementById("eyeOpen");
const eyeClosed = document.getElementById("eyeClosed");

const forgotPassword = document.getElementById("forgotPassword");

const currentYear = document.getElementById("currentYear");


/* =========================================================
   AÑO ACTUAL
   ========================================================= */

if (currentYear) {
    currentYear.textContent = new Date().getFullYear();
}


/* =========================================================
   MOSTRAR / OCULTAR CONTRASEÑA
   ========================================================= */

passwordToggle.addEventListener("click", () => {

    const isPassword =
        passwordInput.type === "password";

    passwordInput.type =
        isPassword ? "text" : "password";

    eyeOpen.classList.toggle(
        "hidden",
        !isPassword
    );

    eyeClosed.classList.toggle(
        "hidden",
        isPassword
    );

    passwordToggle.setAttribute(
        "aria-label",
        isPassword
            ? "Ocultar contraseña"
            : "Mostrar contraseña"
    );

    passwordInput.focus();
});


/* =========================================================
   LIMPIAR ERRORES
   ========================================================= */

function clearErrors() {

    emailError.textContent = "";
    passwordError.textContent = "";

    document
        .querySelectorAll(".form-field")
        .forEach(field => {
            field.classList.remove("has-error");
        });
}


/* =========================================================
   ERROR DE CAMPO
   ========================================================= */

function setFieldError(input, errorElement, message) {

    const field = input.closest(".form-field");

    if (field) {
        field.classList.add("has-error");
    }

    errorElement.textContent = message;
}


/* =========================================================
   VALIDACIÓN DE CORREO
   ========================================================= */

function isValidEmail(email) {

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        .test(email);
}


/* =========================================================
   VALIDACIÓN
   ========================================================= */

function validateForm() {

    clearErrors();

    let valid = true;

    const email =
        emailInput.value.trim();

    const password =
        passwordInput.value;


    if (!email) {

        setFieldError(
            emailInput,
            emailError,
            "Ingresa tu correo electrónico."
        );

        valid = false;

    } else if (!isValidEmail(email)) {

        setFieldError(
            emailInput,
            emailError,
            "Ingresa un correo electrónico válido."
        );

        valid = false;
    }


    if (!password) {

        setFieldError(
            passwordInput,
            passwordError,
            "Ingresa tu contraseña."
        );

        valid = false;
    }


    return valid;
}


/* =========================================================
   MENSAJE GENERAL
   ========================================================= */

function showMessage(message) {

    loginMessage.textContent = message;

    loginMessage.classList.add("visible");
}


function hideMessage() {

    loginMessage.textContent = "";

    loginMessage.classList.remove("visible");
}


/* =========================================================
   ESTADO DE CARGA
   ========================================================= */

function setLoading(isLoading) {

    if (isLoading) {

        loginButton.classList.add("loading");

        loginButton.disabled = true;

        emailInput.disabled = true;

        passwordInput.disabled = true;

        passwordToggle.disabled = true;

        forgotPassword.disabled = true;

    } else {

        loginButton.classList.remove("loading");

        loginButton.disabled = false;

        emailInput.disabled = false;

        passwordInput.disabled = false;

        passwordToggle.disabled = false;

        forgotPassword.disabled = false;
    }
}


/* =========================================================
   LOGIN
   ========================================================= */

/*
    Autenticación real contra Firebase:

        1. signInWithEmailAndPassword (auth.js)
        2. Leer perfil en Firestore (colección "usuarios",
           doc id = uid)
        3. Validar que exista y esté activo
        4. Guardar sesión local
        5. Resolver ruta según rol/operación
        6. Redirigir
*/

async function login(email, password, recordar) {

    setLoading(true);

    hideMessage();

    try {

        const perfil = await iniciarSesion(email, password);

        guardarSesion(perfil, recordar);

        const ruta = resolverRuta(perfil);

        if (!ruta) {

            setLoading(false);

            showMessage(
                "Tu usuario no tiene un rol u operación válidos configurados. " +
                "Contacta al administrador."
            );

            return;
        }

        window.location.href = ruta;

    } catch (error) {

        setLoading(false);

        showMessage(mapearErrorAuth(error));

        console.error("Login error:", error);
    }
}


/* =========================================================
   SUBMIT
   ========================================================= */

loginForm.addEventListener("submit", async event => {

    event.preventDefault();

    hideMessage();

    const isValid = validateForm();

    if (!isValid) {

        const firstError =
            document.querySelector(
                ".form-field.has-error input"
            );

        if (firstError) {
            firstError.focus();
        }

        return;
    }


    const email =
        emailInput.value.trim();

    const password =
        passwordInput.value;

    const recordar =
        document.getElementById("remember")?.checked ?? false;


    await login(
        email,
        password,
        recordar
    );
});


/* =========================================================
   LIMPIEZA DE MENSAJES AL ESCRIBIR
   ========================================================= */

emailInput.addEventListener("input", () => {

    emailInput
        .closest(".form-field")
        ?.classList.remove("has-error");

    emailError.textContent = "";

    hideMessage();
});


passwordInput.addEventListener("input", () => {

    passwordInput
        .closest(".form-field")
        ?.classList.remove("has-error");

    passwordError.textContent = "";

    hideMessage();
});


/* =========================================================
   ENTER / ESC
   ========================================================= */

passwordInput.addEventListener("keydown", event => {

    if (event.key === "Enter") {

        loginForm.requestSubmit();
    }
});


document.addEventListener("keydown", event => {

    if (event.key === "Escape") {

        hideMessage();
    }
});


/* =========================================================
   RECUPERAR CONTRASEÑA
   ========================================================= */

forgotPassword.addEventListener("click", () => {

    hideMessage();

    const email =
        emailInput.value.trim();


    if (!email) {

        setFieldError(
            emailInput,
            emailError,
            "Ingresa primero tu correo electrónico."
        );

        emailInput.focus();

        return;
    }


    if (!isValidEmail(email)) {

        setFieldError(
            emailInput,
            emailError,
            "Ingresa un correo electrónico válido."
        );

        emailInput.focus();

        return;
    }


    recuperarContrasena(email)
        .then(() => {

            showMessage(
                "Te enviamos un correo para restablecer tu contraseña. " +
                "Revisa tu bandeja de entrada (y spam)."
            );
        })
        .catch(error => {

            showMessage(mapearErrorAuth(error));

            console.error("Reset password error:", error);
        });
});


/* =========================================================
   INICIALIZACIÓN
   ========================================================= */

function initializeLogin() {

    emailInput.focus();

}


/* =========================================================
   START
   ========================================================= */

initializeLogin();