-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: configuración SCIM por tenant (provisioning)
--
-- SCIM es un problema DISTINTO de SSO (autenticación): un token de bearer
-- separado, que el IdP del tenant usa para crear/desactivar usuarios de
-- forma automática cuando alguien entra o sale de su Directorio Activo —
-- nunca se usa para loguearse como esa persona.
--
-- token_hash guarda solo el hash (sha256, mismo criterio que
-- refresh_tokens.token_hash/reset_tokens.token_hash) — el valor en texto
-- plano existe una sola vez, en el momento de generarlo/rotarlo (ver
-- platformScim.service.ts), y nunca vuelve a ser recuperable después.
--
-- El índice único sobre token_hash es lo que permite resolver a qué
-- tenant pertenece una request SCIM entrante SOLO por su bearer token
-- (sin Host de por medio — quien llama es el IdP del tenant, no un
-- browser, así que no hay subdominio que resolver primero).
--
-- rotado_en (nullable, distinto de creado_en) deja rastro de si el token
-- vigente es el original o uno rotado — útil para auditoría sin tener que
-- ir a platform_audit_log por ese solo dato.
--
-- EJECUTAR (después de 0027):
--   psql -d mincoreerp -f migrations/0028_tenant_scim_config.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tenant_scim_config (
  tenant_id  UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  activo     BOOLEAN NOT NULL DEFAULT true,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotado_en  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_scim_config_token_hash ON tenant_scim_config(token_hash);
