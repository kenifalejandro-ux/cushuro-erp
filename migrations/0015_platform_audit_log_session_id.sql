-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: session_id en platform_audit_log
--
-- Soporta las sesiones de login del panel respaldadas en Redis
-- (platformSession.service.ts) — permite agrupar todo lo que pasó en una
-- misma sesión de login y filtrar la auditoría por ella (GET /auditoria).
-- Queda NULL para acciones hechas con Authorization: Bearer (curl/
-- integraciones), que son stateless y no tienen sesión.
--
-- EJECUTAR (después de 0014):
--   psql -d mincoreerp -f migrations/0015_platform_audit_log_session_id.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE platform_audit_log ADD COLUMN IF NOT EXISTS session_id TEXT;

-- Parcial: la mayoría de las filas históricas (login por Bearer, o de
-- antes de este cambio) no tienen session_id — indexar todo el universo
-- de filas para filtrar por una sesión puntual sería desperdiciar espacio.
CREATE INDEX IF NOT EXISTS idx_platform_audit_log_session
  ON platform_audit_log(session_id) WHERE session_id IS NOT NULL;
