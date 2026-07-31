-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: tablas base de negocio (repuestos, combustible, documentos)
--
-- Estas tablas nunca quedaron versionadas como SQL en el repo — solo existían
-- ya creadas en la base de datos real, y el código de los repositorios las
-- daba por hechas. Se reconstruyen acá a partir de las columnas que usan
-- src/modules/{repuestos,combustible,documentos}/*.repository.ts, con
-- tenant_id desde el día uno (mismo criterio que 0001_tenants_usuarios.sql).
--
-- Si esta migración corre contra una BD que YA tiene estas tablas (ej.
-- producción), el CREATE TABLE IF NOT EXISTS no hace nada — 0001 se encarga
-- de agregarles tenant_id de forma retroactiva en ese caso.
--
-- EJECUTAR (después de 0001, depende de la tabla tenants):
--   psql -d mincoreerp -f migrations/0002_business_tables.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS repuestos (
  id             SERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  codigo         VARCHAR(50) NOT NULL,
  nombre         VARCHAR(200) NOT NULL,
  categoria      VARCHAR(100) NOT NULL DEFAULT 'General',
  stock          INTEGER NOT NULL DEFAULT 0,
  stock_minimo   INTEGER NOT NULL DEFAULT 5,
  stock_maximo   INTEGER NOT NULL DEFAULT 30,
  precio         NUMERIC(12,2) NOT NULL DEFAULT 0,
  fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- el código es único DENTRO de un tenant, no globalmente (mismo criterio
  -- que usuarios.email en 0001): dos empresas pueden tener ambas "FIL-001"
  UNIQUE (tenant_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_repuestos_tenant ON repuestos(tenant_id);

CREATE TABLE IF NOT EXISTS combustible (
  id                  SERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  tanque_nombre       VARCHAR(100) NOT NULL,
  capacidad_total     NUMERIC(12,2) NOT NULL,
  nivel_actual        NUMERIC(12,2) NOT NULL DEFAULT 0,
  fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_combustible_tenant ON combustible(tenant_id);

CREATE TABLE IF NOT EXISTS documentos (
  id                 SERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  nombre_documento   VARCHAR(200) NOT NULL,
  responsable        VARCHAR(150),
  fecha_vencimiento  DATE,
  estado             VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_documentos_tenant ON documentos(tenant_id);
