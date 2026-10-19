/* shared/core/db.js en memoria: la misma API de Firestore, sin Supabase. */
export * from "./fake-firestore.js";
export const db = { falso: true };
export const supabase = null;
