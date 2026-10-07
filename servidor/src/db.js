/* =========================================================
   INLOTRANS
   Conexión a PostgreSQL

   Este es el ÚNICO lugar que crea el pool de conexiones.
   Todo lo demás importa `consulta` desde aquí.
   ========================================================= */

import pg from "pg";

export const pool = process.env.DATABASE_URL
    ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
    : null;

export async function consulta(sql, parametros = []) {

    if (!pool) {
        throw new Error("DATABASE_URL no está configurada (ver servidor/.env.example)");
    }

    return pool.query(sql, parametros);
}
