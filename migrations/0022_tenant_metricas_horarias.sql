-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: métricas horarias por tenant (observabilidad básica)
--
-- No es un log de requests (eso crecería sin control — una fila por
-- request, para siempre) sino un agregado: un contador que se incrementa
-- por tenant y por hora (date_trunc('hour', now())). tenant_metricas_horarias
-- tiene como mucho `tenants × horas` filas, no `tenants × requests` — a
-- este volumen (panel de administración de un ERP industrial, no
-- telemetría de consumo masivo) alcanza de sobra para "requests
-- recientes", "tasa de error" y una señal simple de actividad anómala de
-- creación de recursos, sin necesitar un sistema de métricas completo
-- tipo Prometheus.
--
-- Sin RLS a propósito, mismo criterio que platform_audit_log/tenant_modulos:
-- el panel de plataforma necesita leer across todos los tenants a la vez
-- para el resumen de salud, y el middleware que escribe acá
-- (tenantMetrics.middleware.ts) corre fuera de cualquier transacción
-- withTenant().
--
-- ON DELETE CASCADE (a diferencia de platform_audit_log, que usa SET
-- NULL): esto es telemetría operativa, no un historial que tenga que
-- sobrevivir por compliance — si un tenant alguna vez se borra de verdad
-- (hoy nunca pasa en producción, solo en la limpieza de tests), sus
-- métricas no tienen ningún motivo para quedar huérfanas.
--
-- EJECUTAR (después de 0021):
--   psql -d mincoreerp -f migrations/0022_tenant_metricas_horarias.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tenant_metricas_horarias (
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hora               TIMESTAMPTZ NOT NULL,
  requests_total     INT NOT NULL DEFAULT 0,
  requests_error_5xx INT NOT NULL DEFAULT 0,
  recursos_creados   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, hora)
);

CREATE INDEX IF NOT EXISTS idx_tenant_metricas_horarias_hora ON tenant_metricas_horarias(hora DESC);
