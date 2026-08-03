-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: identidad SSO en usuarios (por tenant)
--
-- sso_subject/sso_provider quedan NULL hasta el primer login SSO exitoso
-- de ese usuario — el linking (email → sso_subject) lo hace
-- verificarSsoTenantService en su primer login con ese proveedor, nunca
-- esta migración ni un alta manual. Antes de ese primer login, el usuario
-- solo puede entrar por contraseña (si tiene una) — no se toca
-- password_hash acá: a diferencia de platform_admins (0025), un usuario
-- de tenant creado antes de SSO ya tenía contraseña, y uno creado después
-- vía SCIM (ver migrations/0028) recibe una contraseña aleatoria e
-- inutilizable en la práctica en vez de NULL, para no ampliar el mismo
-- NOT NULL que ya protege el resto del login por contraseña — ver
-- platformScim.service.ts.
--
-- UNIQUE compuesto por tenant_id (no global): el mismo `sub` de un
-- proveedor podría, en teoría, repetirse entre dos tenants con IdP
-- distintos sin que sea un conflicto real — el aislamiento multi-tenant
-- de siempre aplica también acá.
--
-- EJECUTAR (después de 0026):
--   psql -d mincoreerp -f migrations/0027_usuarios_sso.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS sso_subject TEXT,
  ADD COLUMN IF NOT EXISTS sso_provider TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_sso
  ON usuarios(tenant_id, sso_provider, sso_subject) WHERE sso_subject IS NOT NULL;
