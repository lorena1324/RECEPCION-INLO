/* =========================================================
   INLOTRANS
   Datos del proyecto de Supabase

   Se copian de Supabase → Project Settings → API:
     - Project URL
     - Publishable key (sb_publishable_...). NUNCA la secret
       ni la service_role: esas dan acceso total.

   La anon key puede ir en el navegador: lo que protege los
   datos son las reglas de supabase/esquema.sql, no esta clave.
   ========================================================= */

export const supabaseConfig = {
    url: "https://kihpfbxgdjnwkhsobpez.supabase.co",
    anonKey: "sb_publishable_zSUQYGfgS74jbb1JfcBbkg_Q2BkgsIH"
};
