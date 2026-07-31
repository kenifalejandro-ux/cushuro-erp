-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: refresh tokens
--
-- El access token (JWT) dura solo 30 minutos (JWT_EXPIRES). Para no obligar
-- a un re-login completo cada 30 min, el login también entrega un refresh
-- token de vida larga (SESSION_TTL_SECONDS, 30 días) que solo sirve para
-- pedir un access token nuevo en POST /api/auth/refresh.
--
-- Es opaco (no JWT): un string aleatorio de 96 hex chars. Se guarda en esta
-- tabla como SHA-256 (token_hash), nunca en texto plano — si la BD se
-- filtrara, los refresh tokens reales no quedarían expuestos.
--
-- Rotación con detección de reuso: cada refresh marca el token usado como
-- revocado y entrega uno nuevo. Si alguien presenta un token que ya figura
-- revocado, es señal de que un token fue robado y ya usado por otro cliente
-- (el legítimo o el atacante) — auth.service.ts responde revocando TODOS
-- los refresh tokens de ese usuario como medida de contención.
--
-- EJECUTAR:
--   psql -d cushuro_erp -f migrations/0004_refresh_tokens.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expira_en   TIMESTAMPTZ NOT NULL,
  revocado_en TIMESTAMPTZ,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_usuario ON refresh_tokens(usuario_id);
