-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: ciclo de vida del tenant (estado)
--
-- Hasta acá `tenants.activo` era un booleano binario: no distinguía "recién
-- creado, todavía sin terminar de configurar" de "suspendido por impago" de
-- "dado de baja, en camino a purgarse". Cuatro estados, cada uno con
-- significado propio (ver docs/architecture/ciclo-de-vida-tenant.md para el
-- detalle completo de qué implica cada uno):
--
--   provisioning     → existe la fila, todavía no está operativo del todo.
--                      Ningún código hoy pone un tenant en este estado (la
--                      creación actual deja el tenant usable de inmediato) —
--                      queda disponible para cuando el onboarding tenga un
--                      paso intermedio real.
--   active           → operación normal. Default de todo tenant nuevo, igual
--                      que `activo = true` hoy.
--   suspended        → acceso cortado (mismo efecto que `activo = false`
--                      hoy: no puede loguear, sesiones abiertas se cortan en
--                      ≤60s), pero reversible y con motivo explícito — ej.
--                      impago, decisión del dueño de la plataforma.
--   pending_deletion → baja programada. Todavía NO existe ningún worker que
--                      purgue tenants en este estado — a propósito, ver el
--                      doc de arquitectura. Este estado solo queda
--                      disponible en el esquema, nadie lo asigna todavía.
--
-- ── Por qué `activo` pasa a ser GENERATED, no una columna aparte ───────────
--
-- Con dos columnas independientes (`estado` y `activo` escritos por
-- separado) quedaría abierta la puerta a que diverjan -- un UPDATE que
-- toque una y se olvide de la otra. Con `activo` calculado por Postgres a
-- partir de `estado`, divergir es imposible: no hay ningún camino de código
-- que pueda escribir `activo` distinto de lo que `estado` implica, porque
-- ya no se puede escribir directo (Postgres lo rechaza en cualquier
-- INSERT/UPDATE que lo intente). El único punto que hoy escribía `activo`
-- (cambiarEstadoTenantService, platform.service.ts) pasa a escribir
-- `estado` -- ver ese archivo.
--
-- Todo el código que hoy LEE `activo` (auth.middleware.ts, auth.service.ts,
-- resolveTenantSubdomain.ts) sigue funcionando sin cambios: `activo = true`
-- sigue siendo exactamente equivalente a `estado = 'active'`, por
-- definición de la columna generada -- no hace falta tocar esos chequeos
-- para que seamos correctos hoy. Migrarlos a leer `estado` directo (para
-- distinguir 'suspended' de 'pending_deletion' en un mensaje de error, por
-- ejemplo) queda para cuando haga falta de verdad -- "incremental" es
-- literal acá: el próximo paso es agregar lectores de `estado`, no
-- reescribir los que ya existen sin necesidad.
--
-- Postgres no permite convertir una columna existente a GENERATED con
-- ALTER COLUMN -- por eso se hace en dos pasos: DROP + ADD. Confirmado
-- antes de escribir esto que no hay ningún índice ni vista sobre
-- tenants.activo (ver pg_indexes / pg_views), así que el DROP no arrastra
-- nada más.
--
-- EJECUTAR (después de 0037):
--   psql -d mincoreerp -f migrations/0038_tenant_estado_ciclo_vida.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'active'
    CHECK (estado IN ('provisioning', 'active', 'suspended', 'pending_deletion'));

-- Backfill: todo tenant activo hoy queda 'active', todo inactivo queda
-- 'suspended' -- es la lectura más fiel de lo que 'activo = false' significó
-- siempre en este sistema (alguien lo desactivó a propósito), y es
-- reversible desde el panel como cualquier otro cambio de estado.
UPDATE tenants SET estado = CASE WHEN activo THEN 'active' ELSE 'suspended' END;

ALTER TABLE tenants DROP COLUMN IF EXISTS activo;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS activo BOOLEAN GENERATED ALWAYS AS (estado = 'active') STORED;
