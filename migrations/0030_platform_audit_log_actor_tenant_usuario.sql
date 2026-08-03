-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: actor_type 'tenant_usuario' en platform_audit_log
--
-- Parte del Contrato de Módulo (docs/adr/0002-contrato-de-modulo.md): a
-- diferencia de los actor_type existentes (todos describen a quién actúa
-- dentro del panel de plataforma), este describe una acción de negocio
-- dentro de un tenant — un usuario normal creando/editando/borrando algo
-- en un módulo del ERP (equipos, checklists, IPERC, etc.). Hasta ahora
-- ningún módulo de negocio auditaba nada; el panel de plataforma solo veía
-- sus propias acciones.
--
-- actor_id es el id de usuarios (RLS, migrations/0010) — NO lleva FK real
-- hacia esa tabla (a diferencia de platform_admins en actor_id de las
-- otras filas): platform_audit_log no tiene RLS a propósito y usuarios sí,
-- una FK cruzada obligaría a decidir en qué tenant validar el id en cada
-- INSERT. tenant_id (columna ya existente) es la referencia real; actor_id
-- queda como dato informativo, igual criterio que usuario_id en el resto
-- de la tabla.
--
-- EJECUTAR (después de 0029):
--   psql -d mincoreerp -f migrations/0030_platform_audit_log_actor_tenant_usuario.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_actor_type_check;

ALTER TABLE platform_audit_log ADD CONSTRAINT platform_audit_log_actor_type_check
  CHECK (actor_type IN ('platform_admin', 'emergency_shared_secret', 'unauthenticated', 'system', 'scim', 'tenant_usuario'));
