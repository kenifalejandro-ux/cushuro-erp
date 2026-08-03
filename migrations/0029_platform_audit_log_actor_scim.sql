-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: actor_type 'scim' en platform_audit_log
--
-- Las operaciones que llegan por el router SCIM (crear/desactivar/
-- reactivar un usuario desde el IdP de un tenant, sin que ningún humano
-- haya tocado el panel) necesitan su propio actor_type — ninguno de los
-- cuatro existentes ('platform_admin', 'emergency_shared_secret',
-- 'unauthenticated', 'system') describe correctamente "lo hizo una
-- integración autenticada con el token SCIM de este tenant".
--
-- actor_id se deja NULL en estas filas (sigue siendo FK a platform_admins,
-- no tiene sentido apuntarlo a tenant_scim_config) — el tenant_id de la
-- fila de auditoría ya identifica de qué integración vino; el detalle
-- puede llevar el id de tenant_scim_config si hace falta trazar una
-- rotación puntual.
--
-- EJECUTAR (después de 0028):
--   psql -d mincoreerp -f migrations/0029_platform_audit_log_actor_scim.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_actor_type_check;

ALTER TABLE platform_audit_log ADD CONSTRAINT platform_audit_log_actor_type_check
  CHECK (actor_type IN ('platform_admin', 'emergency_shared_secret', 'unauthenticated', 'system', 'scim'));
