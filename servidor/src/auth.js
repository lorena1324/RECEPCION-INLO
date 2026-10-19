/* =========================================================
   INLOTRANS
   Quién pide los datos (sesión de Firebase)

   Los datos de Iztech no son públicos: solo los ve quien inició sesión
   en la aplicación. El navegador manda su "ID token" de Firebase
   (Authorization: Bearer …, o `auth.token` en Socket.IO) y aquí se
   comprueba, SIN necesitar ninguna llave de servicio:

     1. La firma y los datos del token (emisor, audiencia, vigencia) se
        verifican con las llaves públicas de Google (JWKS).
     2. El perfil (rol y operación) se lee de Firestore por su REST,
        con el MISMO token del usuario: las reglas de Firestore ya
        dejan a cada quien leer su propio perfil (colección usuarios).
        Si el token fuera falso, Firestore tampoco lo aceptaría.

   Qué puede ver cada uno (igual que las reglas de vehículos):
       administrador  todas las operaciones
       los demás      solo la suya
   Un usuario desactivado (`activo: false`) no ve nada.

   ── CUIDAR LA LECTURA DEL PERFIL ──

   Esa lectura es lo único que esta capa le pide a Firestore, y se
   hace a nombre de cada usuario. Si fallara de forma repetida (HTTP
   429 "demasiadas solicitudes", una caída, un corte de red) y cada
   petición volviera a intentarla, se formaría una bola de nieve: el
   navegador reintenta solo (socket + consulta de respaldo + cada
   pestaña) y cada reintento le pega otra vez a Firestore, que es
   justo lo que lo tiene rechazando. Por eso:

     - El perfil se guarda 5 minutos.
     - UNA sola lectura a la vez por usuario, aunque lleguen veinte
       peticiones juntas.
     - Si la lectura falla por algo pasajero (429, 5xx, red), se FRENA:
       no se vuelve a preguntar hasta que pase una espera que crece
       (15 s, 30 s, 1 min… hasta 5 min, o lo que pida `Retry-After`),
       y mientras tanto se responde "reintenta en N s" sin tocar
       Firestore.
     - Si ya había un perfil guardado (aunque viejo), se usa ese en vez
       de dejar al usuario sin servicio: un cambio de rol tarda unos
       minutos en notarse, no deja a nadie afuera.
   ========================================================= */

import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS_FIREBASE = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const VIGENCIA_PERFIL_MS = 5 * 60_000;       // cuánto se confía en el perfil guardado
const PERFIL_VIEJO_MAX_MS = 60 * 60_000;     // hasta cuándo sirve de respaldo si Firestore falla
const ESPERA_INICIAL_MS = 15_000;
const ESPERA_MAXIMA_MS = 5 * 60_000;

export class ErrorSesion extends Error {
    constructor(mensaje, estado = 401, reintentarEn = null) {
        super(mensaje);
        this.estado = estado;
        this.reintentarEn = reintentarEn;       // segundos, solo en los 503 por saturación
    }
}

// Una falla PASAJERA de la lectura del perfil (la que merece espera y reintento).
class LecturaPasajera extends Error {
    constructor(estado, esperaMs, detalle) {
        super(`HTTP ${estado}`);
        this.estado = estado;
        this.esperaMs = esperaMs;               // lo que pidió Firestore (Retry-After), si lo pidió
        this.detalle = detalle;
    }
}

export function tokenDeCabecera(cabecera) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(cabecera || ""));
    return m ? m[1] : null;
}

export function crearAutenticador({
    projectId,
    jwks = createRemoteJWKSet(new URL(JWKS_FIREBASE)),
    fetchFn = globalThis.fetch,
    ahora = () => Date.now(),
    registrar = (mensaje) => console.warn(mensaje)
}) {

    if (!projectId) throw new Error("Falta FIREBASE_PROJECT_ID (servidor/.env): sin él no se pueden verificar las sesiones.");

    const perfiles = new Map();    // uid → { perfil, en }
    const frenos = new Map();      // uid → { hasta, fallos, estado }
    const enCurso = new Map();     // uid → promesa de la lectura en marcha
    const ultimoAviso = new Map(); // estado → cuándo se avisó por última vez

    // Un aviso por tipo de falla y por minuto: la causa se ve en el log sin llenarlo.
    function avisar(estado, mensaje) {
        const antes = ultimoAviso.get(estado) || 0;
        if (ahora() - antes < 60_000) return;
        ultimoAviso.set(estado, ahora());
        registrar(mensaje);
    }

    async function leerPerfil(uid, idToken) {

        const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/usuarios/${encodeURIComponent(uid)}`;

        let respuesta;
        try {
            respuesta = await fetchFn(url, { headers: { Authorization: `Bearer ${idToken}` }, signal: AbortSignal.timeout(15_000) });
        } catch (error) {
            throw new LecturaPasajera(0, null, error && error.message);       // sin red / tiempo agotado
        }

        if (respuesta.status === 404) throw new ErrorSesion("Tu usuario no tiene perfil en el sistema.", 403);
        if (respuesta.status === 403) throw new ErrorSesion("Firestore no te dejó leer tu perfil (permisos).", 403);

        if (!respuesta.ok) {
            // 429 / 5xx: pasajero. Se guarda un trozo de lo que dijo Firestore para el log: ahí se ve si es
            // "Quota exceeded" (cuota diaria) o un límite de velocidad.
            let detalle = "";
            try { detalle = String(await respuesta.text()).replace(/\s+/g, " ").slice(0, 240); } catch { /* sin cuerpo */ }

            const pedido = Number(respuesta.headers && respuesta.headers.get && respuesta.headers.get("retry-after"));
            throw new LecturaPasajera(respuesta.status, Number.isFinite(pedido) && pedido > 0 ? pedido * 1000 : null, detalle);
        }

        const campos = (await respuesta.json()).fields || {};
        const texto = (c) => (campos[c] && campos[c].stringValue) || "";

        return {
            rol: texto("rol"),
            operacion: texto("operacion"),
            nombre: texto("nombre"),
            activo: campos.activo ? campos.activo.booleanValue !== false : true
        };
    }

    async function perfilDe(uid, idToken) {

        const guardado = perfiles.get(uid);
        if (guardado && ahora() - guardado.en < VIGENCIA_PERFIL_MS) return guardado.perfil;

        const respaldo = guardado && ahora() - guardado.en < PERFIL_VIEJO_MAX_MS ? guardado.perfil : null;

        // En espera por una falla anterior: no se le pregunta a Firestore.
        const freno = frenos.get(uid);
        if (freno && ahora() < freno.hasta) {
            if (respaldo) return respaldo;
            const segundos = Math.max(1, Math.ceil((freno.hasta - ahora()) / 1000));
            throw new ErrorSesion(`El servicio está saturado (Firestore respondió ${freno.estado || "sin conexión"}). Reintenta en ${segundos} s.`, 503, segundos);
        }

        // Una sola lectura a la vez por usuario.
        let lectura = enCurso.get(uid);
        if (!lectura) {
            lectura = leerPerfil(uid, idToken).finally(() => enCurso.delete(uid));
            enCurso.set(uid, lectura);
        }

        try {
            const perfil = await lectura;
            perfiles.set(uid, { perfil, en: ahora() });
            frenos.delete(uid);
            return perfil;

        } catch (error) {

            if (!(error instanceof LecturaPasajera)) throw error;        // 403/404: definitivo, tal cual

            // Espera que crece: 15 s, 30 s, 1 min, 2 min, 4 min, 5 min… (o lo que pidió Firestore).
            const fallos = (frenos.get(uid)?.fallos || 0) + 1;
            const espera = error.esperaMs || Math.min(ESPERA_MAXIMA_MS, ESPERA_INICIAL_MS * 2 ** (fallos - 1));
            frenos.set(uid, { hasta: ahora() + espera, fallos, estado: error.estado });

            avisar(error.estado, `[auth] No se pudo leer el perfil en Firestore (${error.estado ? "HTTP " + error.estado : "sin conexión"}): ` +
                `${error.detalle || "sin detalle"}. Se frena ${Math.round(espera / 1000)} s` +
                `${respaldo ? " y se usa el perfil guardado" : ""}. (Si es 429 con "Quota exceeded": revisa el uso de Firestore en la consola de Firebase.)`);

            if (respaldo) return respaldo;
            throw new ErrorSesion(`El servicio está saturado (Firestore respondió ${error.estado || "sin conexión"}). Reintenta en ${Math.round(espera / 1000)} s.`, 503, Math.round(espera / 1000));
        }
    }

    /* Verifica el token y devuelve la sesión: { uid, rol, operacion, nombre }. */
    async function autenticar(idToken) {

        if (!idToken) throw new ErrorSesion("Falta iniciar sesión.");

        let payload;
        try {
            ({ payload } = await jwtVerify(idToken, jwks, { issuer: `https://securetoken.google.com/${projectId}`, audience: projectId }));
        } catch {
            throw new ErrorSesion("La sesión no es válida o venció. Vuelve a iniciar sesión.");
        }

        const uid = payload.user_id || payload.sub;
        if (!uid) throw new ErrorSesion("La sesión no trae usuario.");

        const perfil = await perfilDe(uid, idToken);
        if (!perfil.activo) throw new ErrorSesion("Tu usuario está desactivado.", 403);
        if (!perfil.rol) throw new ErrorSesion("Tu usuario no tiene rol asignado.", 403);

        return { uid, rol: perfil.rol, operacion: perfil.operacion, nombre: perfil.nombre };
    }

    return { autenticar };
}

/* ¿Esta sesión puede ver esa operación? */
export function puedeVer(sesion, operacion) {
    if (!sesion) return false;
    return sesion.rol === "administrador" || (!!operacion && sesion.operacion === operacion);
}
