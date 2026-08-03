-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: outbox transaccional de plataforma
--
-- Un evento que necesita un efecto en OTRO sistema (hoy: poblar el cache
-- de Redis de una respuesta idempotente; a futuro: un webhook) se escribe
-- acá DENTRO de la misma transacción que el cambio de negocio que lo
-- origina — así el evento nunca se pierde ni queda "fantasma" por una
-- falla justo entre "ya hice el cambio" y "ya avisé para afuera". Antes,
-- la respuesta de Idempotency-Key se escribía en Redis DESPUÉS del commit
-- de crearTenantConAdminService, sin ninguna garantía de que esa segunda
-- escritura corriera si el proceso caía en el medio — un retry con la
-- misma key, pasado el TTL de la reserva, podía terminar creando un
-- tenant duplicado. Ver platformOutbox.service.ts / platformIdempotency.service.ts.
--
-- El índice único (tipo, clave) no es solo de lookup: es el backstop de
-- correctitud contra dos transacciones concurrentes con la misma
-- Idempotency-Key nunca vista — la segunda choca acá y su transacción
-- entera se revierte, incluido el tenant que hubiera creado de más.
--
-- platformOutbox.worker.ts drena esta tabla con un poll simple
-- (setInterval) — a esta escala (panel de administración, no un pipeline
-- de eventos de alto tráfico) no hace falta más que eso.
--
-- EJECUTAR (después de 0017):
--   psql -d mincoreerp -f migrations/0018_platform_outbox.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS platform_outbox (
  id           BIGSERIAL PRIMARY KEY,
  tipo         TEXT NOT NULL,
  clave        TEXT,
  payload      JSONB NOT NULL,
  estado       TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'procesado', 'fallido')),
  intentos     INT NOT NULL DEFAULT 0,
  procesado_en TIMESTAMPTZ,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_outbox_tipo_clave
  ON platform_outbox(tipo, clave) WHERE clave IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_platform_outbox_pendientes
  ON platform_outbox(creado_en) WHERE estado = 'pendiente';
