/* =========================================================
   Compila el motor 3D como librería para la app actual.

       npm run build:muelles3d

   Sale a shared/vendor/muelles3d/, que la app actual carga
   directo (sin compilar nada más), igual que carga Chart.js.
   Ese archivo SÍ va a git: la app actual se publica tal cual.
   ========================================================= */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],

    // En modo librería Vite no reemplaza process.env; React lo
    // necesita para saber que es producción.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },

    build: {
        outDir: "../shared/vendor/muelles3d",
        emptyOutDir: true,
        lib: {
            entry: "src/integracion/motor.jsx",
            formats: ["es"],
            fileName: () => "muelles3d.js"
        },
        // En modo librería Vite deja los espacios sin minificar;
        // para una página que lo descarga en cada bodega, se fuerza.
        rolldownOptions: { output: { minify: true } },
        chunkSizeWarningLimit: 2000
    }
});
