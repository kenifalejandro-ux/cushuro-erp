-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: latencia y errores 4xx en tenant_metricas_horarias
--
-- tenant_metricas_horarias (0022) ya cuenta requests_total y
-- requests_error_5xx por tenant/hora, pero no dice nada de qué tan rápido
-- respondió el ERP ni de los 4xx (cuota agotada, módulo no habilitado,
-- validación) — que también son señal de salud del tenant, distinta de un
-- 5xx real.
--
-- latencia_total_ms es una SUMA, no un promedio: promediar promedios por
-- hora daría un resultado mal ponderado si una hora tuvo 5 requests y otra
-- 5000. El promedio real se calcula en la lectura como
-- latencia_total_ms / requests_total (ver platformTenantHealth.service.ts),
-- igual que ya se hace con tasaError = errores / requests.
--
-- No se agrega una columna aparte para 2xx: se deriva como
-- requests_total - requests_error_4xx - requests_error_5xx al leer: esta
-- API no emite 3xx, así que alcanza sin otra columna que mantener en el
-- INSERT ... ON CONFLICT.
--
-- EJECUTAR (después de 0035):
--   psql -d mincoreerp -f migrations/0036_tenant_metricas_latencia.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE tenant_metricas_horarias
  ADD COLUMN IF NOT EXISTS latencia_total_ms BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS requests_error_4xx INT NOT NULL DEFAULT 0;
