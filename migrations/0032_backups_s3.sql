-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: backups en S3 (storage/key por backup) + backups de plataforma
--
-- Ver docs/architecture/backups-s3.md. Dos cambios independientes:
--
-- 1) tenant_backups pasa a registrar DÓNDE está cada backup, no solo cómo
--    se llama el archivo. Hasta ahora `archivo` era un nombre plano que
--    solo tenía sentido relativo a BACKUPS_DIR; con S3 hace falta la key
--    completa (con su jerarquía tenants/{id}/{YYYY}/{MM}/) y saber con qué
--    driver se escribió.
--
--    `storage` se llena con 'local' para todo lo existente: es la verdad
--    de esos backups, están en disco. Así un despliegue que migre a S3
--    sigue pudiendo restaurar lo viejo sin ningún paso de migración de
--    datos — platformBackupStorage.ts lee el driver de la fila, no del
--    entorno (el entorno solo decide dónde se ESCRIBE lo nuevo).
--
--    `archivo` se conserva (no se renombra ni se borra) por compatibilidad:
--    la columna nueva `storage_key` es la que usan las rutas nuevas, y para
--    las filas viejas se backfillea con el mismo valor de `archivo`, que es
--    exactamente la ruta relativa correcta dentro de BACKUPS_DIR.
--
-- 2) platform_backups: tabla nueva para los respaldos de la capa de
--    plataforma (tenants, platform_admins, asignación de módulos, config de
--    SSO/SCIM) — el metadato que hace falta para reconstruir la plataforma
--    en un disaster recovery, y que NINGÚN backup por tenant contiene.
--    Deliberadamente NO incluye datos de negocio de los tenants (eso ya lo
--    cubre tenant_backups) ni platform_audit_log/platform_outbox (ver
--    platformBackupPlataforma.service.ts sobre por qué).
--
--    Sin RLS, igual que tenant_backups y el resto de las tablas de
--    plataforma: el panel necesita leerlas/escribirlas fuera de cualquier
--    transacción con app.tenant_id seteado.
--
-- EJECUTAR (después de 0031):
--   psql -d mincoreerp -f migrations/0032_backups_s3.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) tenant_backups: dónde vive cada backup ───────────────────────────
ALTER TABLE tenant_backups ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT 'local';

DO $$ BEGIN
  ALTER TABLE tenant_backups ADD CONSTRAINT tenant_backups_storage_check
    CHECK (storage IN ('local', 's3'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE tenant_backups ADD COLUMN IF NOT EXISTS storage_key TEXT;

-- Backfill: para las filas existentes la key ES el nombre de archivo, que
-- ya era la ruta relativa correcta dentro de BACKUPS_DIR.
UPDATE tenant_backups SET storage_key = archivo WHERE storage_key IS NULL;

DO $$ BEGIN
  ALTER TABLE tenant_backups ALTER COLUMN storage_key SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

-- ── 2) Backups de la capa de plataforma ─────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_backups (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  storage      TEXT NOT NULL DEFAULT 'local',
  storage_key  TEXT NOT NULL,
  tamano_bytes BIGINT NOT NULL,
  tablas       JSONB NOT NULL,
  estado       TEXT NOT NULL DEFAULT 'completo',
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE platform_backups ADD CONSTRAINT platform_backups_storage_check
    CHECK (storage IN ('local', 's3'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE platform_backups ADD CONSTRAINT platform_backups_estado_check
    CHECK (estado IN ('completo', 'fallido'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Mismo patrón (tenant_id, creado_en DESC) que idx_tenant_backups_tenant,
-- pero acá no hay tenant: el listado siempre es "los más nuevos primero".
CREATE INDEX IF NOT EXISTS idx_platform_backups_creado ON platform_backups(creado_en DESC);

-- La retención (platformBackupRetention.worker.ts) recorre backups viejos
-- filtrando por creado_en dentro de un tenant — este índice cubre ese
-- recorrido además del listado del panel (ver ADR de indexación, 0031:
-- idx_tenant_backups_tenant ya es (tenant_id, creado_en DESC), así que
-- esa parte no necesita nada nuevo).
