-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: dueño de una Orden de Trabajo (asignado_a)
--
-- Sin esto, la cola de OT abiertas no tenía dueño -- "pensaba que lo hacía
-- otro" es el problema real que resuelve. `creado_por` (quién la abrió) y
-- `asignado_a` (a quién le toca ejecutarla) son roles distintos a
-- propósito: quien reporta una falla no es necesariamente quien la repara.
--
-- ON DELETE SET NULL, no CASCADE ni RESTRICT: si el usuario asignado se
-- borra, la OT no debe desaparecer ni bloquear el borrado del usuario --
-- mismo criterio que equipo_id/creado_por... salvo que creado_por SÍ es
-- NOT NULL sin ON DELETE (una OT siempre tiene autor, ver migración 0049);
-- acá el campo es opcional por diseño (una OT puede no tener dueño
-- todavía), así que ON DELETE SET NULL es lo correcto.
--
-- EJECUTAR (después de 0049, depende de ordenes_trabajo/usuarios):
--   psql -d mincoreerp -f migrations/0051_ordenes_trabajo_asignado_a.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS asignado_a UUID REFERENCES usuarios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ordenes_trabajo_asignado_a
  ON ordenes_trabajo(asignado_a) WHERE asignado_a IS NOT NULL;
