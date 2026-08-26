/* =========================================================
   INLOTRANS
   Inicialización central de Firebase

   Este es el ÚNICO archivo que debe llamar initializeApp().
   Todo lo demás importa `auth` y `db` desde aquí.
   ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Se usa initializeFirestore() en vez de getFirestore() para poder
// pasarle experimentalAutoDetectLongPolling: true — así Firestore
// detecta solo cuando el navegador no puede sostener la conexión
// por QUIC/WebChannel (firewalls, antivirus, VPN, ciertos proveedores
// de internet) y cae automáticamente a long-polling en su lugar.
// Sin esto, esas redes ven "ERR_QUIC_PROTOCOL_ERROR" y la app se
// queda sin poder leer ni escribir nada.
export const db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true
});