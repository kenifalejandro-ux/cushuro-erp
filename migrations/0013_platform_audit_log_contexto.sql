-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: contexto adicional en platform_audit_log
--
-- Agrega lo que faltaba para auditar de verdad el panel de plataforma:
--   - user_agent: distingue un browser humano de un script/integración
--     golpeando el panel con el mismo secreto compartido.
--   - resultado: permite registrar también intentos fallidos (token
--     incorrecto, validación rechazada) y no solo acciones que sí se
--     ejecutaron — hoy platform_audit_log solo tiene éxitos.
--
-- EJECUTAR (después de 0012):
--   psql -d mincoreerp -f migrations/0013_platform_audit_log_contexto.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE platform_audit_log ADD COLUMN IF NOT EXISTS user_agent TEXT;

ALTER TABLE platform_audit_log ADD COLUMN IF NOT EXISTS resultado TEXT NOT NULL DEFAULT 'success';

DO $$ BEGIN
  ALTER TABLE platform_audit_log ADD CONSTRAINT platform_audit_log_resultado_check
    CHECK (resultado IN ('success', 'failure'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Parcial: solo indexa los fallos (subconjunto chico), que es lo que se va
-- a querer recorrer para revisar intentos de acceso/validación rechazados.
CREATE INDEX IF NOT EXISTS idx_platform_audit_log_resultado ON platform_audit_log(resultado) WHERE resultado = 'failure';
