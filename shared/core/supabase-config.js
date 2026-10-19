/* =========================================================
   INLOTRANS
   Datos del proyecto de Supabase

   Se copian de Supabase → Project Settings → API:
     - Project URL
     - anon public key  (NO la service_role: esa es secreta)

   La anon key puede ir en el navegador: lo que protege los
   datos son las reglas de supabase/esquema.sql, no esta clave.
   ========================================================= */

export const supabaseConfig = {
    url: "https://TU-PROYECTO.supabase.co",
    anonKey: "TU-ANON-KEY"
};
