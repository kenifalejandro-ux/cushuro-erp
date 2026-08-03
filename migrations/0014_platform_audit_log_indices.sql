-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: índice compuesto en platform_audit_log
--
-- Con 0013 (fallos de auth/validación, login/logout de sesión) la tabla
-- crece más rápido que antes. El acceso real —listarAuditoriaService—
-- siempre ordena por creado_en DESC, opcionalmente filtrado por tenant_id;
-- los dos índices compuestos de acá sirven ese patrón mejor que los dos
-- índices simples que había, que quedan redundantes (un índice compuesto
-- ya cubre consultas por su columna líder) y se eliminan para no pagar el
-- mantenimiento de escritura de cuatro índices en cada INSERT.
--
-- (creado_en DESC, id): además de la vista global ordenada, deja lista la
-- paginación por cursor (keyset) si en algún momento se reemplaza el LIMIT
-- plano de listarAuditoriaService.
--
-- EJECUTAR (después de 0013):
--   psql -d mincoreerp -f migrations/0014_platform_audit_log_indices.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_platform_audit_log_tenant_creado
  ON platform_audit_log(tenant_id, creado_en DESC);

CREATE INDEX IF NOT EXISTS idx_platform_audit_log_creado_id
  ON platform_audit_log(creado_en DESC, id);

DROP INDEX IF EXISTS idx_platform_audit_log_tenant;
DROP INDEX IF EXISTS idx_platform_audit_log_creado;
