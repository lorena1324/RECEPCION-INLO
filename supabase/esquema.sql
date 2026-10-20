/* =========================================================
   INLOTRANS — Esquema de Supabase (reemplaza a Firestore)

   Se corre UNA vez en Supabase → SQL Editor → New query →
   pegar todo este archivo → Run. Se puede volver a correr:
   no borra datos (todo es "if not exists" / "or replace").

   ── CÓMO ESTÁ ORGANIZADO ──

   Cada colección de Firestore es una tabla con la misma forma:

       id       text   (el id del documento)
       datos    jsonb  (el documento tal cual, con los mismos
                        nombres de campo que usaba la app)
       version  bigint (sube en cada escritura: con ella se
                        detectan los choques entre transacciones,
                        igual que hacía Firestore)

   Así el código de shared/services casi no cambió: habla con
   shared/core/db.js, que imita la API de Firestore encima de
   Supabase.

   La excepción es `usuarios`, que tiene columnas de verdad
   (nombre, rol, operacion…) porque se llena a mano desde el
   panel de Supabase.

   ── SEGURIDAD (antes firestore.rules) ──

   LEER: políticas RLS por tabla (select).
   ESCRIBIR: nadie escribe directo en las tablas. Toda escritura
   pasa por la función aplicar_escrituras(), que revisa el
   permiso de CADA documento con puede_escribir() — la traducción
   una a una de firestore.rules — y aplica todo o nada.
   ========================================================= */


/* =========================================================
   TABLAS
   ========================================================= */

create table if not exists public.usuarios (
    id          uuid primary key references auth.users (id) on delete cascade,
    nombre      text not null default '',
    rol         text not null check (rol in ('operario', 'supervisor', 'cliente', 'administrador')),
    operacion   text check (operacion in ('J3', 'J4', 'B9')),
    cliente     text,
    activo      boolean not null default true,
    creado_en   timestamptz not null default now()
);

create table if not exists public.vehiculos (
    id              text primary key,
    datos           jsonb not null default '{}',
    version         bigint not null default 1,
    actualizado_en  timestamptz not null default now(),
    operacion       text generated always as (datos ->> 'operacion') stored
);

create table if not exists public.placas_activas (
    id              text primary key,          -- "{operacion}_{PLACA}"
    datos           jsonb not null default '{}',
    version         bigint not null default 1,
    actualizado_en  timestamptz not null default now(),
    operacion       text generated always as (datos ->> 'operacion') stored
);

create table if not exists public.cobros (
    id              text primary key,          -- el mismo id del vehículo
    datos           jsonb not null default '{}',
    version         bigint not null default 1,
    actualizado_en  timestamptz not null default now(),
    operacion       text generated always as (datos ->> 'operacion') stored
);

-- config/{operacion}: id = "J3" | "J4" | "B9"
create table if not exists public.config (
    id              text primary key,
    datos           jsonb not null default '{}',
    version         bigint not null default 1,
    actualizado_en  timestamptz not null default now(),
    operacion       text generated always as (id) stored
);

-- config/{operacion}/privado/{documento}: id = "J3/tarifas"
create table if not exists public.config_privado (
    id              text primary key,
    datos           jsonb not null default '{}',
    version         bigint not null default 1,
    actualizado_en  timestamptz not null default now(),
    operacion       text generated always as (split_part(id, '/', 1)) stored
);

create index if not exists vehiculos_operacion_idx on public.vehiculos (operacion);
create index if not exists vehiculos_activos_idx on public.vehiculos (operacion) where (datos ->> 'horaSalida') is null;
create index if not exists cobros_operacion_idx on public.cobros (operacion);


/* =========================================================
   QUIÉN ESTÁ PIDIENDO
   ========================================================= */

create or replace function public.mi_perfil()
returns public.usuarios
language sql stable security definer set search_path = public
as $$
    select * from public.usuarios where id = auth.uid()
$$;

create or replace function public.es_activo()
returns boolean
language sql stable security definer set search_path = public
as $$
    select coalesce((select activo from public.usuarios where id = auth.uid()), false)
$$;

create or replace function public.mi_rol()
returns text
language sql stable security definer set search_path = public
as $$
    select rol from public.usuarios where id = auth.uid() and activo
$$;

create or replace function public.mi_operacion()
returns text
language sql stable security definer set search_path = public
as $$
    select operacion from public.usuarios where id = auth.uid() and activo
$$;

create or replace function public.es_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
    select coalesce(public.mi_rol() = 'administrador', false)
$$;

-- El administrador no tiene operación: entra a todas.
create or replace function public.en_su_operacion(op text)
returns boolean
language sql stable security definer set search_path = public
as $$
    select coalesce(public.mi_operacion() = op, false)
$$;


/* =========================================================
   LECTURA (RLS)
   ========================================================= */

alter table public.usuarios       enable row level security;
alter table public.vehiculos      enable row level security;
alter table public.placas_activas enable row level security;
alter table public.cobros         enable row level security;
alter table public.config         enable row level security;
alter table public.config_privado enable row level security;

-- Cada quien lee su propio perfil (lo necesita el login); el administrador, todos.
drop policy if exists usuarios_leer on public.usuarios;
create policy usuarios_leer on public.usuarios for select to authenticated
    using (id = auth.uid() or public.es_admin());

drop policy if exists vehiculos_leer on public.vehiculos;
create policy vehiculos_leer on public.vehiculos for select to authenticated
    using (public.es_admin() or public.en_su_operacion(operacion));

drop policy if exists placas_leer on public.placas_activas;
create policy placas_leer on public.placas_activas for select to authenticated
    using (public.es_admin() or public.en_su_operacion(split_part(id, '_', 1)));

-- El dinero: ni el operario ni el cliente.
drop policy if exists cobros_leer on public.cobros;
create policy cobros_leer on public.cobros for select to authenticated
    using (public.es_admin() or (public.mi_rol() = 'supervisor' and public.en_su_operacion(operacion)));

drop policy if exists config_leer on public.config;
create policy config_leer on public.config for select to authenticated
    using (public.es_admin() or public.en_su_operacion(id));

drop policy if exists config_privado_leer on public.config_privado;
create policy config_privado_leer on public.config_privado for select to authenticated
    using (public.es_admin() or (public.mi_rol() = 'supervisor' and public.en_su_operacion(operacion)));

-- Ninguna tabla tiene políticas de insert/update/delete: escribir
-- directo queda prohibido. Solo se escribe con aplicar_escrituras().
revoke insert, update, delete on
    public.usuarios, public.vehiculos, public.placas_activas,
    public.cobros, public.config, public.config_privado
from anon, authenticated;

-- Las tarifas son privadas: ¿puede este usuario verlas? (para distinguir
-- "no hay tarifas guardadas" de "no tienes permiso", como hacía Firestore).
create or replace function public.puede_leer_privado(op text)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin() or (public.mi_rol() = 'supervisor' and public.en_su_operacion(op))
$$;


/* =========================================================
   AYUDANTES PARA LAS REGLAS
   ========================================================= */

-- Las claves de primer nivel que cambian entre dos versiones del
-- documento (el affectedKeys() de Firestore).
create or replace function public.claves_cambiadas(antes jsonb, despues jsonb)
returns text[]
language sql immutable
as $$
    select coalesce(array_agg(k), '{}')
    from (
        select jsonb_object_keys(coalesce(antes, '{}')) as k
        union
        select jsonb_object_keys(coalesce(despues, '{}'))
    ) claves
    where coalesce(antes, '{}') -> k is distinct from coalesce(despues, '{}') -> k
$$;

-- `null` de JSON o campo ausente: los dos son "vacío".
create or replace function public.es_nulo(valor jsonb)
returns boolean
language sql immutable
as $$
    select valor is null or valor = 'null'::jsonb
$$;


/* =========================================================
   PERMISO DE ESCRITURA (antes firestore.rules)

   antes   = el documento actual (null si no existe)
   despues = como quedaría (null si se borra)
   ========================================================= */

create or replace function public.puede_escribir(tabla text, doc_id text, antes jsonb, despues jsonb)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
    rol        text := public.mi_rol();
    op         text := public.mi_operacion();
    admin      boolean := public.es_admin();
    cambiadas  text[];
    op_doc     text;
    crear      boolean := antes is null;
    borrar     boolean := despues is null;
begin
    if rol is null then
        return false;                       -- sin perfil o inactivo: nada
    end if;

    /* ── config y config/privado: solo el administrador ── */
    if tabla in ('config', 'config_privado') then
        return admin;
    end if;

    /* ── cobros ── */
    if tabla = 'cobros' then
        if admin then return true; end if;
        if borrar then return false; end if;           -- un cobro no se borra: se corrige
        if crear then
            return rol = 'supervisor' and despues ->> 'operacion' = op;
        end if;
        return rol = 'supervisor' and antes ->> 'operacion' = op;
    end if;

    /* ── placas_activas (el candado de placa) ── */
    if tabla = 'placas_activas' then
        if admin then return true; end if;
        if rol not in ('operario', 'supervisor') then return false; end if;
        if borrar then
            return antes ->> 'operacion' = op;
        end if;
        -- El candado tiene que llamarse como su operación y su placa.
        if doc_id is distinct from (despues ->> 'operacion') || '_' || (despues ->> 'placaClave') then
            return false;
        end if;
        if crear then
            return despues ->> 'operacion' = op;
        end if;
        return antes ->> 'operacion' = op and despues ->> 'operacion' = op;
    end if;

    /* ── vehiculos ── */
    if tabla = 'vehiculos' then

        -- CREAR: operario de la bodega, o supervisor solo para citas canceladas.
        if crear then
            return admin
                or (rol = 'operario'   and despues ->> 'operacion' = op)
                or (rol = 'supervisor' and despues ->> 'operacion' = op
                                       and despues -> 'cancelado' = 'true'::jsonb);
        end if;

        op_doc := antes ->> 'operacion';

        -- BORRAR: administrador y operario de esa bodega.
        if borrar then
            return admin or (rol = 'operario' and op_doc = op);
        end if;

        -- UN CONTENEDOR SIN CABEZOTE NO SALE (ni el administrador).
        if antes -> 'sinCabezote' = 'true'::jsonb
           and public.es_nulo(antes -> 'horaSalida')
           and not public.es_nulo(despues -> 'horaSalida') then
            return false;
        end if;

        if admin then return true; end if;

        cambiadas := public.claves_cambiadas(antes, despues);

        -- SIN TIPOLOGÍA NO SE CARGA AVANCE (donde la bodega tiene tipologías).
        if coalesce(antes ->> 'tipologia', '') = ''
           and cambiadas && array['avanceTipo', 'avancePorcentaje', 'avanceCarguePendiente',
                                  'pickingCargue', 'pickingDescargue',
                                  'auditoriaCargue', 'auditoriaDescargue']
           and (
                (jsonb_typeof(despues -> 'avancePorcentaje') = 'number'
                 and (despues ->> 'avancePorcentaje')::numeric > 0)
                or cambiadas && array['pickingCargue', 'pickingDescargue',
                                      'auditoriaCargue', 'auditoriaDescargue']
           )
           and jsonb_array_length(coalesce(
                   (select c.datos -> 'tipologias' from public.config c where c.id = op_doc),
                   '[]'::jsonb)) > 0 then
            return false;
        end if;

        if op_doc is distinct from op then
            return false;
        end if;

        -- Operario: todo menos lo que firma el supervisor.
        if rol = 'operario' then
            return not (cambiadas && array['autorizacionSalida', 'pagoRegistrado',
                                           'cancelado', 'cancelacion', 'anulacionSalida']);
        end if;

        -- Supervisor: sus campos; en J4 puede corregir todo el registro.
        if rol = 'supervisor' then
            return op_doc = any (array['J4'])
                or cambiadas <@ array[
                    'avanceTipo', 'avancePorcentaje', 'avanceCarguePendiente',
                    'autorizacionSalida', 'historial', 'pagoRegistrado',
                    'pickingCargue', 'auditoriaCargue',
                    'pickingDescargue', 'auditoriaDescargue',
                    'cancelado', 'cancelacion', 'horaSalida', 'operadorSalida',
                    'obsSalida', 'anulacionSalida', 'obsUbicacion',
                    'modalidad', 'tipologia', 'tipologiaNombre',
                    'sinCabezote'
                ];
        end if;

        return false;
    end if;

    return false;                           -- cualquier otra tabla: cerrada
end
$$;


/* =========================================================
   APLICAR CAMBIOS A UN DOCUMENTO

   Resuelve los marcadores que manda shared/core/db.js:
     {"__op":"arrayUnion","valores":[...]}  → agrega sin repetir
     {"__op":"serverTimestamp"}             → la hora del servidor
     {"__op":"deleteField"}                 → quita el campo
   ========================================================= */

create or replace function public.aplicar_campos(base jsonb, cambios jsonb)
returns jsonb
language plpgsql immutable
as $$
declare
    k        text;
    v        jsonb;
    actual   jsonb;
    item     jsonb;
    resultado jsonb := coalesce(base, '{}');
begin
    for k, v in select * from jsonb_each(coalesce(cambios, '{}')) loop

        if jsonb_typeof(v) = 'object' and v ? '__op' then

            if v ->> '__op' = 'serverTimestamp' then
                resultado := resultado || jsonb_build_object(k, to_jsonb(now()));

            elsif v ->> '__op' = 'deleteField' then
                resultado := resultado - k;

            elsif v ->> '__op' = 'arrayUnion' then
                actual := case when jsonb_typeof(resultado -> k) = 'array' then resultado -> k else '[]'::jsonb end;
                for item in select * from jsonb_array_elements(coalesce(v -> 'valores', '[]')) loop
                    if not actual @> jsonb_build_array(item) then
                        actual := actual || jsonb_build_array(item);
                    end if;
                end loop;
                resultado := resultado || jsonb_build_object(k, actual);

            else
                raise exception 'Operación desconocida: %', v ->> '__op';
            end if;

        else
            resultado := resultado || jsonb_build_object(k, v);
        end if;
    end loop;

    return resultado;
end
$$;


/* =========================================================
   ESCRIBIR (todo o nada)

   lecturas:   [{ "tabla", "id", "version" }]   lo que leyó la
               transacción; version null = "no existía".
               Si algo cambió desde entonces → CONFLICTO, y el
               navegador reintenta la transacción desde cero.
   escrituras: [{ "tipo": "set"|"update"|"delete",
                  "tabla", "id", "datos", "merge" }]
   ========================================================= */

create or replace function public.aplicar_escrituras(lecturas jsonb, escrituras jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    tablas    constant text[] := array['vehiculos', 'placas_activas', 'cobros', 'config', 'config_privado'];
    l         jsonb;
    e         jsonb;
    tabla     text;
    doc_id    text;
    ver       bigint;
    antes     jsonb;
    despues   jsonb;
begin
    if auth.uid() is null then
        raise exception 'PERMISO_DENEGADO' using errcode = '42501';
    end if;

    -- 1. Lo que la transacción leyó sigue igual (y queda bloqueado hasta el final).
    for l in select * from jsonb_array_elements(coalesce(lecturas, '[]')) loop
        tabla := l ->> 'tabla';
        if not tabla = any (tablas) then raise exception 'Tabla no permitida: %', tabla; end if;

        execute format('select version from public.%I where id = $1 for update', tabla)
            into ver using l ->> 'id';

        if ver is distinct from (l ->> 'version')::bigint then
            -- OJO: NO usar 40001 (serialization_failure). PostgREST reintenta solo
            -- esa transacción, el choque se repite igual y la conexión queda
            -- atrapada: con varios choques se agota el pool y cae toda la API.
            -- El navegador reconoce el choque por el texto CONFLICTO y reintenta él.
            raise exception 'CONFLICTO' using errcode = 'P0001';
        end if;
    end loop;

    -- 2. Cada escritura, con su permiso.
    for e in select * from jsonb_array_elements(coalesce(escrituras, '[]')) loop
        tabla  := e ->> 'tabla';
        doc_id := e ->> 'id';
        if not tabla = any (tablas) then raise exception 'Tabla no permitida: %', tabla; end if;

        antes := null;
        execute format('select datos from public.%I where id = $1 for update', tabla)
            into antes using doc_id;

        if e ->> 'tipo' = 'delete' then
            despues := null;
        elsif e ->> 'tipo' = 'update' then
            if antes is null then
                raise exception 'NO_EXISTE' using errcode = 'P0002';
            end if;
            despues := public.aplicar_campos(antes, e -> 'datos');
        elsif e ->> 'tipo' = 'set' then
            despues := public.aplicar_campos(
                case when (e -> 'merge') = 'true'::jsonb then antes else '{}'::jsonb end,
                e -> 'datos');
        else
            raise exception 'Tipo de escritura desconocido: %', e ->> 'tipo';
        end if;

        if antes is null and despues is null then
            continue;                               -- borrar lo que no existe: nada que hacer
        end if;

        -- coalesce: una regla que da NULL (campo ausente) es un NO, no un "quizás".
        if not coalesce(public.puede_escribir(tabla, doc_id, antes, despues), false) then
            raise exception 'PERMISO_DENEGADO' using errcode = '42501';
        end if;

        if despues is null then
            execute format('delete from public.%I where id = $1', tabla) using doc_id;
        else
            execute format(
                'insert into public.%I as t (id, datos) values ($1, $2)
                 on conflict (id) do update
                 set datos = excluded.datos, version = t.version + 1, actualizado_en = now()',
                tabla) using doc_id, despues;
        end if;
    end loop;
end
$$;

revoke all on function public.aplicar_escrituras(jsonb, jsonb) from public, anon;
grant execute on function public.aplicar_escrituras(jsonb, jsonb) to authenticated;
grant execute on function public.puede_leer_privado(text) to authenticated;


/* =========================================================
   TIEMPO REAL (reemplaza a onSnapshot)
   ========================================================= */

do $$
declare t text;
begin
    foreach t in array array['vehiculos', 'placas_activas', 'cobros', 'config', 'config_privado'] loop
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
        ) then
            execute format('alter publication supabase_realtime add table public.%I', t);
        end if;
    end loop;
end
$$;
