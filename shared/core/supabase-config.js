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
    url: "https://kihpfbxgdjnwkhsobpez.supabase.co",
    anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpaHBmYnhnZGpud2toc29icGV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0NDU1MTcsImV4cCI6MjEwODAyMTUxN30.oOQM0WCGWKlIxUYGP7rC8oZ1xzZcpsHWA06MOJJNGA0"
};
