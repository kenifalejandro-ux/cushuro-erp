-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: metadata de backups por tenant
--
-- El contenido del backup en sí (JSON con las filas exportadas) vive en
-- filesystem (ver platformBackupStorage.ts, BACKUPS_DIR) — esta tabla es
-- solo el índice: qué backups existen, de qué tenant, cuándo, y un resumen
-- de qué tablas/cuántas filas tiene cada uno, para poder listarlos sin
-- tener que abrir cada archivo.
--
-- Sin RLS a propósito, mismo criterio que el resto de las tablas de
-- plataforma: el panel necesita leer/escribir esto para cualquier tenant,
-- fuera de cualquier transacción con app.tenant_id seteado.
--
-- ON DELETE CASCADE en tenant_id: igual criterio que tenant_metricas_horarias
-- (0022) — si el tenant se borra de verdad alguna vez, el índice de sus
-- backups no tiene motivo para quedar huérfano (el archivo en disco sí
-- podría limpiarse aparte, pero eso es un job de mantenimiento futuro, no
-- parte de este primer paso).
--
-- EJECUTAR (después de 0022):
--   psql -d mincoreerp -f migrations/0023_tenant_backups.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tenant_backups (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  archivo      TEXT NOT NULL,
  tamano_bytes BIGINT NOT NULL,
  tablas       JSONB NOT NULL,
  estado       TEXT NOT NULL DEFAULT 'completo',
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE tenant_backups ADD CONSTRAINT tenant_backups_estado_check
    CHECK (estado IN ('completo', 'fallido'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_tenant_backups_tenant ON tenant_backups(tenant_id, creado_en DESC);
