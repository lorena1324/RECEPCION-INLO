/* =========================================================
   INLOTRANS
   Cliente de Supabase

   Este es el ÚNICO archivo que crea el cliente. Todo lo demás
   importa `supabase` desde aquí (o usa shared/core/db.js).
   ========================================================= */

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

import { supabaseConfig } from "./supabase-config.js";

export const supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
    }
});
