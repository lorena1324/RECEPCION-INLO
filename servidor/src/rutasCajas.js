/* =========================================================
   INLOTRANS
   Cajas por vehículo: la ruta HTTP y el tiempo real (Socket.IO)

   Aparte de index.js para poder probarlo con una sesión de mentira
   (el autenticador se inyecta): así se prueba de verdad, con sockets
   reales, el requisito de los 30 s y quién ve qué.

   HTTP   GET /api/cajas?operacion=J3   (Authorization: Bearer <token>)
   Socket las pantallas se conectan con `io({ auth: { token } })` y se
          suscriben a una operación. Cuando las cajas cambian se les
          empuja de inmediato; en cada refresco sin novedades reciben
          solo un latido con la hora.

   Quién ve qué: el administrador, cualquier operación; los demás,
   solo la suya (puedeVer en auth.js).
   ========================================================= */

import { ErrorSesion, puedeVer, tokenDeCabecera } from "./auth.js";

export function montarRutasCajas({ app, io, autenticador, cajas, operaciones }) {

    /* ── HTTP ─────────────────────────────────────────────────── */

    app.get("/api/cajas", async (req, res) => {

        try {
            const sesion = await autenticador.autenticar(tokenDeCabecera(req.headers.authorization));
            const operacion = String(req.query.operacion || sesion.operacion || "");

            if (!puedeVer(sesion, operacion)) return res.status(403).json({ error: "No tienes acceso a esa operación." });

            res.json(cajas.paraOperacion(operacion));

        } catch (error) {
            const estado = error instanceof ErrorSesion ? error.estado : 500;

            // Saturación de Firestore (503 con espera): se le dice al navegador cuánto esperar y
            // NO se registra aquí, auth.js ya avisó la causa (una vez por minuto, sin llenar el log).
            if (estado === 503 && error.reintentarEn) {
                res.set("Retry-After", String(error.reintentarEn));
                return res.status(503).json({ error: error.message, reintentarEn: error.reintentarEn });
            }

            if (estado >= 500) console.error("[cajas] /api/cajas:", error.message);
            res.status(estado).json({ error: estado >= 500 ? "No se pudo atender la consulta." : error.message });
        }
    });


    /* ── Tiempo real ──────────────────────────────────────────── */

    io.use(async (socket, next) => {
        try {
            socket.data.sesion = await autenticador.autenticar(socket.handshake.auth && socket.handshake.auth.token);
            next();
        } catch (error) {
            const rechazo = new Error(error instanceof ErrorSesion ? error.message : "No se pudo verificar la sesión.");
            // El navegador lee `error.data`: con una espera pedida, deja de reintentar hasta entonces.
            if (error instanceof ErrorSesion && error.reintentarEn) rechazo.data = { reintentarEn: error.reintentarEn };
            next(rechazo);
        }
    });

    io.on("connection", (socket) => {

        const sesion = socket.data.sesion;

        const suscribir = (operacion) => {
            if (!puedeVer(sesion, operacion)) return false;
            for (const sala of socket.rooms) if (sala.startsWith("op:")) socket.leave(sala);
            socket.join(`op:${operacion}`);
            socket.emit("cajas", cajas.paraOperacion(operacion));
            return true;
        };

        socket.on("suscribir", (operacion, respuesta) => {
            const ok = suscribir(String(operacion || ""));
            if (typeof respuesta === "function") respuesta({ ok });
        });

        // Por defecto, la suya.
        if (sesion.operacion) suscribir(sesion.operacion);
    });

    cajas.alCambiar((cambio) => {
        if (cambio) {
            for (const operacion of operaciones) io.to(`op:${operacion}`).emit("cajas", cajas.paraOperacion(operacion));
        }
        io.emit("latido", { generadoEn: cajas.estado().generadoEn });
    });
}
