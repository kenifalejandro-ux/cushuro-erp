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
-- IMPORTANTE — actor_id queda NULL en estas filas. La columna tiene una FK
-- contra platform_admins (migración 0016), así que NO puede guardar el id
-- de un usuario de tenant: esos viven en `usuarios`. Quién actuó va en
-- `usuario_id` (FK contra usuarios, ya existente desde la migración 0012) y
-- su email en actor_label.
--
-- Una versión anterior de este comentario afirmaba que actor_id no tenía
-- FK. Era falso, y el costo fue concreto: cada intento de auditar una
-- acción de módulo violaba la FK, y como registrarAuditoria() nunca tira
-- (traga el error y loguea un warning), la auditoría de los módulos de
-- negocio se perdió en silencio hasta que un test la exigió.
--
-- EJECUTAR (después de 0029):
--   psql -d mincoreerp -f migrations/0030_platform_audit_log_actor_tenant_usuario.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_actor_type_check;

ALTER TABLE platform_audit_log ADD CONSTRAINT platform_audit_log_actor_type_check
  CHECK (actor_type IN ('platform_admin', 'emergency_shared_secret', 'unauthenticated', 'system', 'scim', 'tenant_usuario'));
