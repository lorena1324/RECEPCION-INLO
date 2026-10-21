/* =========================================================
   INLOTRANS — Dar de alta a un usuario

   1. Supabase → Authentication → Users → "Add user" →
      "Create new user": correo + contraseña, y marcar
      "Auto Confirm User".
   2. Copiar aquí su correo y el rol/operación, y correr esto
      en el SQL Editor.

   Roles:      'administrador' | 'facturacion' | 'supervisor' | 'operario' | 'cliente'
   Operación:  'J3' | 'J4' | 'B9'   (null para el administrador)
   ========================================================= */

insert into public.usuarios (id, nombre, rol, operacion, cliente, activo)
select id, 'Nombre Apellido', 'administrador', null, null, true
from auth.users
where email = 'correo@ejemplo.com'
on conflict (id) do update
set nombre = excluded.nombre,
    rol = excluded.rol,
    operacion = excluded.operacion,
    cliente = excluded.cliente,
    activo = excluded.activo;

-- Desactivar a alguien (no puede entrar ni escribir):
-- update public.usuarios set activo = false
-- where id = (select id from auth.users where email = 'correo@ejemplo.com');
