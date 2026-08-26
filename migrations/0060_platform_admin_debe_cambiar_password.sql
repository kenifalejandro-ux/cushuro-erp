-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: clave temporal + cambio obligatorio en el primer login
--
-- Cuando un super_admin da de alta otro Platform Admin (POST /admins) le
-- pone una contraseña temporal a mano y se la pasa por fuera del sistema.
-- debe_cambiar_password marca esa cuenta para que el panel la obligue a
-- poner su propia contraseña antes de dejarla usar nada más (ver
-- cambiarMiPasswordService en platformAdminAccount.service.ts). No hay
-- correo ni token de por medio: la prueba de identidad es que solo el
-- creador y el nuevo admin conocen la clave temporal.
--
-- DEFAULT false para no afectar admins ya existentes -- se activa
-- explícito en el INSERT de crearPlatformAdminService, no desde el default
-- de la columna.
--
-- EJECUTAR (después de 0059):
--   psql -d mincoreerp -f migrations/0060_platform_admin_debe_cambiar_password.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS debe_cambiar_password BOOLEAN NOT NULL DEFAULT false;
