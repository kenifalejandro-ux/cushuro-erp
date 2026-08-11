-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: archivo real para el módulo Documentos (PDF/imagen + versionado)
--
-- Hasta acá `documentos` era solo metadata (nombre, responsable, vencimiento,
-- estado) -- una lista de control, sin el PDF/licencia real adjunto. Esta
-- migración NO toca esa tabla: agrega `documentos_versiones` como historial
-- de archivos subidos para cada fila de `documentos`. La "versión actual" es
-- la más reciente por `subido_en`, sin columna puntero en `documentos` -- así
-- el módulo sigue funcionando exactamente igual para quien nunca sube nada.
--
-- `storage_driver` guarda CON QUÉ driver se subió cada versión (no un
-- setting global) -- mismo criterio que `tenant_backups.storage` en
-- migrations/0032_backups_s3.sql: si el día de mañana se cambia
-- DOCUMENTOS_STORAGE_DRIVER de local a s3, las versiones viejas en disco
-- local se siguen pudiendo descargar, cada una con el driver que le
-- corresponde.
--
-- EJECUTAR (después de 0042):
--   psql -d mincoreerp -f migrations/0043_documentos_versiones.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS documentos_versiones (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  documento_id    INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  storage_driver  TEXT NOT NULL,
  storage_key     TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  tamano_bytes    INTEGER NOT NULL,
  nombre_original TEXT NOT NULL,
  subido_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  subido_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documentos_versiones_storage_driver_check'
  ) THEN
    ALTER TABLE documentos_versiones ADD CONSTRAINT documentos_versiones_storage_driver_check
      CHECK (storage_driver IN ('local', 's3'));
  END IF;
END $$;

-- Cubre el filtro de RLS y "traeme las versiones de este documento,
-- la más nueva primero" en el mismo índice.
CREATE INDEX IF NOT EXISTS idx_documentos_versiones_documento
  ON documentos_versiones(documento_id, subido_en DESC);

CREATE INDEX IF NOT EXISTS idx_documentos_versiones_tenant
  ON documentos_versiones(tenant_id);

-- Nullable (un usuario borrado no debe borrar el historial de versiones) --
-- mismo criterio parcial que idx_platform_audit_log_usuario.
CREATE INDEX IF NOT EXISTS idx_documentos_versiones_subido_por
  ON documentos_versiones(subido_por) WHERE subido_por IS NOT NULL;

-- Mismo criterio que migrations/0005 y 0042: FORCE es imprescindible, si no
-- el owner de la tabla (el rol con el que se conecta la app) queda exento de
-- RLS y la policy nunca se aplicaría a las queries de la propia app.
ALTER TABLE documentos_versiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE documentos_versiones FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'documentos_versiones' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON documentos_versiones
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
