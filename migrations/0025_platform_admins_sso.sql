-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: SSO para Platform Admin (proveedor único global)
--
-- Un solo proveedor OIDC para TODO platform_admins (el dueño del ERP es una
-- sola organización, a diferencia del SSO por tenant que sí necesita
-- guardarse por empresa — ver migrations/0026_tenant_sso_config.sql). La
-- configuración del proveedor (issuer/client_id/client_secret) vive en env
-- (PLATFORM_SSO_*, ver env.ts), no acá — mismo criterio que
-- GOOGLE_LOGIN_CLIENT_ID: es un secreto operado por el equipo, no un dato
-- de negocio en la base.
--
-- password_hash pasa a nullable: un admin que entra 100% por SSO no
-- necesita contraseña. El CHECK de abajo evita el estado inválido
-- "ni contraseña ni SSO" (una cuenta que nadie podría autenticar nunca).
--
-- El linking (email → sso_subject) ocurre en el primer login SSO exitoso,
-- no acá — ver platformAdminSso.service.ts. No hay auto-registro: igual
-- que googleLoginService, el admin ya tiene que existir (alta manual desde
-- POST /api/platform/admins, autenticado con el secreto compartido o por
-- un super_admin).
--
-- EJECUTAR (después de 0024):
--   psql -d mincoreerp -f migrations/0025_platform_admins_sso.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE platform_admins
  ADD COLUMN IF NOT EXISTS sso_subject TEXT,
  ADD COLUMN IF NOT EXISTS sso_provider TEXT;

ALTER TABLE platform_admins ALTER COLUMN password_hash DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE platform_admins ADD CONSTRAINT platform_admins_password_o_sso
    CHECK (password_hash IS NOT NULL OR (sso_subject IS NOT NULL AND sso_provider IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_admins_sso
  ON platform_admins(sso_provider, sso_subject) WHERE sso_subject IS NOT NULL;
