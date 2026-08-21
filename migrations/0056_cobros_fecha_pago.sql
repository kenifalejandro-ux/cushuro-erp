-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: fecha real del pago en cobros de implementación
--
-- `creado_en` significa "cuándo se cargó el registro en el sistema", no
-- "cuándo pasó el pago" -- un cobro de implementación que se carga hoy
-- pero corresponde a un pago del 8 de agosto necesitaba poder decirlo.
-- Solo tiene sentido para tipo='implementacion' (los de tipo='suscripcion'
-- ya tienen `creado_en` preciso, se crean en el momento real del cobro).
--
-- EJECUTAR (después de 0055):
--   psql -d mincoreerp -f migrations/0056_cobros_fecha_pago.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE cobros ADD COLUMN IF NOT EXISTS fecha_pago DATE;
