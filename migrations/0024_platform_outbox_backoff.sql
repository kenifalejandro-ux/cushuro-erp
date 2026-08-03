-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: backoff + lease-locking para platform_outbox
--
-- Endurece el outbox de migrations/0018_platform_outbox.sql para que sea
-- seguro con más de una instancia del server corriendo el worker a la vez:
--
-- - disponible_en: además de marcar cuándo un evento puede procesarse por
--   primera vez, funciona como "lease" — al reclamar un lote, el worker
--   empuja disponible_en unos segundos hacia adelante ANTES de ejecutar el
--   handler (ver platformOutbox.service.ts: reclamarPendientes). Si el
--   proceso muere a mitad de un handler, el evento vuelve a estar
--   disponible solo cuando esa ventana expira — nunca antes, así dos
--   instancias no lo agarran al mismo tiempo — y nunca se pierde, porque
--   el estado sigue en 'pendiente' hasta que se confirme el resultado.
--   También es lo que permite backoff real tras un fallo (antes, un evento
--   fallido volvía a 'pendiente' y el próximo poll (unos segundos después)
--   lo reintentaba de inmediato, sin espera creciente).
-- - ultimo_error: guarda el mensaje del último intento fallido — hasta
--   ahora un evento en estado 'fallido' no dejaba ningún rastro de POR QUÉ
--   falló, solo que falló.
--
-- El índice viejo (creado_en) WHERE estado='pendiente' ya no alcanza: el
-- worker ahora filtra también por disponible_en <= now(), así que el
-- índice necesita esa columna para seguir siendo un index scan y no un
-- seq scan a medida que la tabla crece.
--
-- EJECUTAR (después de 0023):
--   psql -d mincoreerp -f migrations/0024_platform_outbox_backoff.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE platform_outbox
  ADD COLUMN IF NOT EXISTS disponible_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS ultimo_error TEXT;

DROP INDEX IF EXISTS idx_platform_outbox_pendientes;

CREATE INDEX IF NOT EXISTS idx_platform_outbox_pendientes
  ON platform_outbox(estado, disponible_en, creado_en) WHERE estado = 'pendiente';
