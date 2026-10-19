# INLOTRANS con Supabase

La app ya no usa Firebase: el login es **Supabase Auth** y los datos viven en **Postgres de Supabase**, con tiempo real por **Supabase Realtime**.

## Puesta en marcha (una sola vez)

1. **Crear el proyecto** en <https://supabase.com/dashboard> → *New project*.
2. **Crear las tablas y reglas**: *SQL Editor* → *New query* → pegar todo [`esquema.sql`](esquema.sql) → *Run*.
3. **Conectar la app**: *Project Settings* → *API* y copiar en [`shared/core/supabase-config.js`](../shared/core/supabase-config.js):
   - `url` ← *Project URL*
   - `anonKey` ← *anon public* (nunca la `service_role`)
4. **Crear usuarios**: *Authentication* → *Users* → *Add user* (marcar *Auto Confirm User*), y luego asignarle rol y operación con [`usuarios.sql`](usuarios.sql). Empieza por un `administrador`.
5. **Recuperar contraseña** (opcional): *Authentication* → *URL Configuration* → poner en *Site URL* la dirección donde se publica la app (p. ej. `http://localhost:3100`).

Después: `npm run dev` y abrir <http://localhost:3100>.

## Cómo está hecho

| Antes (Firebase) | Ahora (Supabase) |
|---|---|
| `shared/core/firebase.js` | `shared/core/supabase.js` (cliente) |
| SDK de Firestore | `shared/core/db.js`: las mismas funciones (`doc`, `getDocs`, `runTransaction`, `onSnapshot`…) sobre Supabase, así los servicios no cambiaron |
| Colecciones | Tablas `vehiculos`, `placas_activas`, `cobros`, `config`, `config_privado` con `{ id, datos jsonb, version }` |
| Colección `usuarios` | Tabla `usuarios` con columnas (`nombre`, `rol`, `operacion`, `cliente`, `activo`) |
| `firestore.rules` | Lectura: políticas RLS. Escritura: función `aplicar_escrituras()` que revisa cada documento con `puede_escribir()` y aplica todo o nada |
| Transacciones | Optimistas como en Firestore: si lo leído cambió, el servidor responde `CONFLICTO` y el navegador reintenta |

Nadie puede escribir directo en las tablas (ni desde la consola del navegador): todo pasa por `aplicar_escrituras()`.

## Pendiente / a tener en cuenta

- `firestore.rules` y `migracion/` quedan solo como referencia; ya no se usan.
- La integración con Iztech (`servidor/`, apagada) todavía verifica sesiones de Firebase; si se reactiva hay que cambiar `servidor/src/auth.js` para validar el token de Supabase.
