-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: token_version para revocación de sesión sin depender de Redis
--
-- Problema que resuelve: antes, la única forma de invalidar un JWT antes de
-- su expiración natural era borrar su copia en Redis (session:{id}). Si el
-- servidor corría sin Redis configurado (documentado como opcional en
-- .env.example), el logout no invalidaba nada y el JWT seguía siendo válido
-- hasta expirar por su cuenta.
--
-- Con esta columna, el JWT incluye tokenVersion y authMiddleware lo compara
-- contra el valor actual en esta tabla (con cache de 60s, ver
-- shared/utils/token-version-cache.ts). Revocar TODAS las sesiones de un
-- usuario = incrementar este número — funciona con o sin Redis.
--
-- EJECUTAR:
--   psql -d cushuro_erp -f migrations/0002_token_version.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;
