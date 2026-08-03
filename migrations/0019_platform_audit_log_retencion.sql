-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: política de retención documentada + evaluación de particionado
--
-- POLÍTICA DE RETENCIÓN (recomendación de ingeniería, no una interpretación
-- legal — confirmar el número exacto con quien tenga la última palabra en
-- compliance de la empresa):
--   - Retener platform_audit_log un mínimo de 7 años. Es la auditoría de
--     un ERP usado en minería (IPERC, checklists de equipos); varias
--     jurisdicciones mineras exigen retención larga de registros de
--     seguridad y trazabilidad administrativa — 7 años es un piso
--     razonable mientras se confirma el requisito exacto aplicable.
--   - Por default NO se borra nada automáticamente. El borrado periódico
--     (ver src/server/services/platformAuditRetention.worker.ts) es
--     opt-in vía PLATFORM_AUDIT_RETENTION_DAYS — sin esa variable, el
--     worker no hace nada. Guardar de más nunca rompe compliance; borrar
--     de menos sí.
--
-- PARTICIONADO: evaluado y descartado por ahora. Al momento de escribir
-- esto, platform_audit_log tiene ~555 filas / 424 kB — muy por debajo de
-- donde particionar por mes empieza a pagar su propia complejidad
-- operativa (migrar partición por partición, mantener rangos, vacuum por
-- partición). Revisar esta decisión si la tabla supera el orden de
-- 5-10 millones de filas o unos pocos GB — al ritmo de uso de un panel de
-- administración (no telemetría de alto volumen), llegar ahí tomaría
-- años. Si en algún momento se justifica, particionar por RANGE de
-- creado_en (mensual) es directo: toda consulta ya filtra por fecha o
-- pagina por (creado_en, id) — ver listarAuditoriaService en
-- platformAudit.service.ts — así que las particiones se podrían excluir
-- solas en la mayoría de los casos (partition pruning).
--
-- EJECUTAR (después de 0018):
--   psql -d mincoreerp -f migrations/0019_platform_audit_log_retencion.sql
-- ═══════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE platform_audit_log IS
  'Auditoría del panel de plataforma. Retención recomendada: mínimo 7 años '
  '(confirmar con compliance — contexto de minería/IPERC). Borrado periódico '
  'opt-in vía PLATFORM_AUDIT_RETENTION_DAYS (ver '
  'platformAuditRetention.worker.ts); sin configurar, no se borra nada. '
  'Particionado evaluado y descartado por bajo volumen — revisar si supera '
  'el orden de 5-10M filas.';
