/* =========================================================
   INLOTRANS
   Cajas y estibas por vehículo (llegan del servidor)

   Las pantallas NUNCA hablan con Iztech: el token vive solo en el
   servidor. Piden las cajas a nuestra API, con la sesión de
   Firebase del usuario, y el servidor responde solo lo de su
   operación (el administrador, la que pida).

   REQUISITO: ningún dispositivo puede ir más de 30 s atrasado.
     - Camino principal: Socket.IO. El servidor EMPUJA cada cambio en
       cuanto lo ve, y manda un latido en cada refresco sin novedades.
     - Respaldo: si el socket no conecta, se consulta /api/cajas cada
       10 s. El respaldo existe para no quedarse sin dato, no para
       ser el camino normal.

   Si la página no está servida por nuestro servidor (o el usuario no
   tiene sesión) no se rompe nada: simplemente no hay cajas que
   mostrar, y `callback(null, error)` lo avisa una vez.
   ========================================================= */

import { auth } from "../core/firebase.js";

const SEGUNDOS_RESPALDO = 10;

async function tokenDeSesion() {
    // Al abrir la página la sesión puede estar todavía restaurándose.
    if (typeof auth.authStateReady === "function") await auth.authStateReady();
    const usuario = auth.currentUser;
    return usuario ? usuario.getIdToken() : null;
}

/*
    Se suscribe a las cajas de una operación. `callback(datos)` recibe
    { generadoEn, obsoleta, vehiculos: { PLACA: {...} } } cada vez que
    algo cambia. Devuelve la función para dejar de escuchar.

    opciones: { base, obtenerToken } — para pruebas.
*/
export function suscribirseACajas(operacion, callback, opciones) {

    const base = (opciones && opciones.base) || "";
    const obtenerToken = (opciones && opciones.obtenerToken) || tokenDeSesion;

    let activo = true;
    let socket = null;
    let temporizador = null;
    let avisoDeError = false;

    // Si el servidor dice "estoy saturado, espera N s" (HTTP 503/429 o un rechazo del socket con
    // `data.reintentarEn`), no se vuelve a preguntar hasta entonces: reintentar a lo loco solo
    // empeora la saturación que se está intentando superar.
    let pausaHasta = 0;
    const pausar = (segundos) => { pausaHasta = Math.max(pausaHasta, Date.now() + (Number(segundos) || 30) * 1000); };

    const recibir = (datos) => { if (activo && datos) callback(datos); };

    const fallar = (error) => {
        if (!activo || avisoDeError) return;
        avisoDeError = true;
        callback(null, error);
    };

    async function consultar() {
        if (Date.now() < pausaHasta) return;

        try {
            const token = await obtenerToken();
            if (!token) throw new Error("Sin sesión");

            const r = await fetch(`${base}/api/cajas?operacion=${encodeURIComponent(operacion)}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (r.status === 429 || r.status === 503) pausar(Number(r.headers.get("Retry-After")));
            if (!r.ok) throw new Error(`HTTP ${r.status}`);

            avisoDeError = false;
            recibir(await r.json());

        } catch (error) {
            fallar(error);
        }
    }

    function iniciarRespaldo() {
        if (temporizador || !activo) return;
        consultar();
        temporizador = setInterval(consultar, SEGUNDOS_RESPALDO * 1000);
    }

    function detenerRespaldo() {
        clearInterval(temporizador);
        temporizador = null;
    }

    // Socket.IO lo sirve el propio servidor (/socket.io/socket.io.esm.min.js).
    import(`${base}/socket.io/socket.io.esm.min.js`)
        .then(({ io }) => {
            if (!activo) return;

            socket = io(base || undefined, {
                // Función: se pide un token nuevo en cada reconexión (los tokens vencen).
                auth: (dar) => { obtenerToken().then((token) => dar({ token })); },
                // Reintentos espaciados (5 s, creciendo hasta 1 min), no cada segundo.
                reconnectionDelay: 5000,
                reconnectionDelayMax: 60000
            });

            socket.on("connect", () => {
                detenerRespaldo();
                avisoDeError = false;
                socket.emit("suscribir", operacion);
            });
            socket.on("cajas", recibir);
            socket.on("connect_error", (error) => {
                if (error && error.data && error.data.reintentarEn) pausar(error.data.reintentarEn);
                iniciarRespaldo();
                fallar(error);
            });
            socket.on("disconnect", iniciarRespaldo);
        })
        .catch(iniciarRespaldo);

    return function dejarDeEscuchar() {
        activo = false;
        detenerRespaldo();
        if (socket) socket.disconnect();
    };
}
