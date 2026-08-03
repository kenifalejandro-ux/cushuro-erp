-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: configuración de SSO por tenant (OIDC)
--
-- A diferencia del SSO de Platform Admin (un solo proveedor global, ver
-- 0025), cada tenant es una empresa distinta que puede tener su propio IdP
-- (Okta, Azure AD, Google Workspace, etc.) — necesita guardarse por tenant.
--
-- client_secret_cifrado NUNCA en texto plano: se cifra con AES-256-GCM
-- antes de guardarse (ver platformCrypto.ts / APP_ENCRYPTION_KEY) y se
-- descifra solo en el momento de armar el intercambio con el proveedor —
-- un dump de esta tabla sin la clave de aplicación no expone nada usable.
--
-- dominio_email_permitido es defensa en profundidad, no el control
-- principal: el control real de "quién puede entrar" sigue siendo que el
-- sso_subject devuelto coincida con un usuario YA existente en
-- usuarios (ver migrations/0027) — este campo solo filtra, antes de
-- siquiera buscar ese match, un id_token cuyo email ni pertenece al
-- dominio esperado de la organización.
--
-- activo por defecto en false: cargar la configuración no debe habilitar
-- el botón de SSO en el login hasta que alguien confirme que probó el
-- flujo (evita que un typo en el issuer_url deje a los usuarios del tenant
-- viendo un botón que siempre falla).
--
-- Sin RLS a propósito, igual que tenant_modulos/tenant_backups: el panel
-- de plataforma necesita leer/escribir la config de cualquier tenant.
--
-- EJECUTAR (después de 0025):
--   psql -d mincoreerp -f migrations/0026_tenant_sso_config.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tenant_sso_config (
  tenant_id               UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  proveedor               TEXT NOT NULL DEFAULT 'oidc' CHECK (proveedor IN ('oidc', 'saml')),
  issuer_url              TEXT NOT NULL,
  client_id               TEXT NOT NULL,
  client_secret_cifrado   TEXT NOT NULL,
  dominio_email_permitido TEXT,
  activo                  BOOLEAN NOT NULL DEFAULT false,
  creado_en               TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en          TIMESTAMPTZ NOT NULL DEFAULT now()
);
