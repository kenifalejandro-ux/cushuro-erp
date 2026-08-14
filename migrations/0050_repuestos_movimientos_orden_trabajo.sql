-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: vínculo opcional de un movimiento de repuestos a una Orden de
-- Trabajo
--
-- Motivo original que hizo saltar la necesidad de todo el módulo
-- `ordenes_trabajo` (ver migración 0049 y memoria
-- nuevo_modulo_ordenes_trabajo): `repuestos_movimientos.origen` ya
-- anticipaba esto ("deja lugar a un origen distinto -- ej. integración con
-- una futura Orden de Trabajo -- el día que exista, sin migración nueva"),
-- pero faltaba la columna real. Ahora que OT existe y está probada, se
-- agrega la FK.
--
-- Sin reserva de stock ni "esperando repuesto" -- un movimiento vinculado a
-- una OT se comporta exactamente igual que uno sin vincular (mismo delta
-- atómico sobre `repuestos.stock`, mismo rechazo por stock insuficiente).
-- El vínculo es solo trazabilidad en este PR.
--
-- EJECUTAR (después de 0049, depende de ordenes_trabajo):
--   psql -d mincoreerp -f migrations/0050_repuestos_movimientos_orden_trabajo.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE repuestos_movimientos ADD COLUMN IF NOT EXISTS orden_trabajo_id INTEGER REFERENCES ordenes_trabajo(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_repuestos_movimientos_orden_trabajo
  ON repuestos_movimientos(orden_trabajo_id) WHERE orden_trabajo_id IS NOT NULL;
