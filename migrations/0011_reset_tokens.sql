-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: recuperación de contraseña
--
-- Mismo patrón que refresh_tokens (auth.service.ts): token opaco, solo se
-- guarda el hash SHA-256 — si la BD se filtrara, los tokens de recuperación
-- reales no quedarían expuestos. tenant_id denormalizado por el mismo
-- motivo que en refresh_tokens (0010_usuarios_rls.sql): hace falta saber
-- el tenant ANTES de poder leer `usuarios` bajo RLS.
--
-- Sin RLS (igual criterio que refresh_tokens): no es una tabla que un
-- usuario consulte directamente, es infraestructura de un flujo puntual.
--
-- EJECUTAR (después de 0001, depende de tenants/usuarios):
--   psql -d mincoreerp -f migrations/0011_reset_tokens.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS reset_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  token_hash  TEXT NOT NULL UNIQUE,
  expira_en   TIMESTAMPTZ NOT NULL,
  usado_en    TIMESTAMPTZ,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reset_tokens_usuario ON reset_tokens(usuario_id);
