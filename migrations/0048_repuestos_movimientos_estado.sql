-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: estado de un movimiento de repuestos (aplicado/rechazado)
--
-- Escenario que resuelve: un rechazo por stock insuficiente (0047 en
-- adelante, ver repuestos.repository.ts) hasta ahora NO insertaba fila en
-- `repuestos_movimientos` -- el intento quedaba sin ningún rastro, ni en
-- el servidor ni, si el operario no llegaba a leer el banner de
-- EstadoOffline.tsx (que es puro estado en memoria del navegador, se
-- pierde al cerrar/recargar), tampoco en el dispositivo. Dos técnicos
-- offline sacando el último repuesto disponible: uno sincroniza primero y
-- gana, el otro se descarta sin dejar evidencia de que el movimiento
-- FÍSICO igual pasó.
--
-- Con `estado`, un rechazo SIGUE sin tocar `stock` (la garantía que se
-- buscaba: nunca queda negativo) pero SÍ deja la fila -- así un admin
-- puede reconciliar después ("hubo 2 salidas compitiendo por la última
-- unidad") en vez de que el intento se pierda para siempre.
--
-- EJECUTAR (después de 0047):
--   psql -d mincoreerp -f migrations/0048_repuestos_movimientos_estado.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE repuestos_movimientos
  ADD COLUMN IF NOT EXISTS estado VARCHAR(10) NOT NULL DEFAULT 'aplicado';

DO $$ BEGIN
  ALTER TABLE repuestos_movimientos ADD CONSTRAINT repuestos_movimientos_estado_valido
    CHECK (estado IN ('aplicado', 'rechazado'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Todas las filas existentes son de ANTES de que existiera el rechazo
-- persistente (0046/0047 solo insertaban cuando el UPDATE de stock tenía
-- éxito) -- el DEFAULT de arriba ya las deja correctamente en 'aplicado',
-- no hace falta un UPDATE de backfill.
