-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: IPERC Línea Base + unificación de Continuo/Específico
--
-- El ERP es SaaS: cada tenant necesita su propio catálogo de riesgos
-- aprobado (Línea Base) del cual Continuo y Específico puedan tomar
-- líneas ya evaluadas, en vez de pedir texto libre cada vez. Es el
-- documento madre que exige la normativa peruana de SST (Ley 29783 /
-- DS 024-2016-EM en minería) y que hoy faltaba.
--
-- Continuo y Específico comparten toda su estructura (mismo flujo de
-- aprobación, mismo shape de ítems) — se unifican en las tablas ipercs/
-- iperc_items ya existentes con una columna `tipo`, en vez de triplicar
-- módulos casi idénticos.
--
-- ALTER sobre tablas ya existentes, no recreación: no hay datos reales
-- todavía, no hace falta migración de datos.
--
-- EJECUTAR (después de 0006, depende de ipercs/iperc_items/usuarios):
--   psql -d mincoreerp -f migrations/0007_iperc_linea_base.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Línea Base ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS iperc_lineas_base (
  id                SERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  proceso_actividad VARCHAR(200) NOT NULL,
  area_frente       VARCHAR(200),
  estado            VARCHAR(20) NOT NULL DEFAULT 'borrador',
  aprobado_por      UUID REFERENCES usuarios(id),
  aprobado_en       TIMESTAMPTZ,
  creado_por        UUID NOT NULL REFERENCES usuarios(id),
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT iperc_lineas_base_estado_check CHECK (estado IN ('borrador', 'aprobado', 'rechazado'))
);

CREATE INDEX IF NOT EXISTS idx_iperc_lineas_base_tenant ON iperc_lineas_base(tenant_id);

CREATE TABLE IF NOT EXISTS iperc_linea_base_items (
  id              SERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  linea_base_id   INTEGER NOT NULL REFERENCES iperc_lineas_base(id) ON DELETE CASCADE,
  etapa_actividad VARCHAR(300) NOT NULL,
  peligro         VARCHAR(300) NOT NULL,
  riesgo          VARCHAR(300) NOT NULL,
  probabilidad    SMALLINT NOT NULL CHECK (probabilidad BETWEEN 1 AND 4),
  severidad       SMALLINT NOT NULL CHECK (severidad BETWEEN 1 AND 4),
  nivel_riesgo    SMALLINT GENERATED ALWAYS AS (probabilidad * severidad) STORED,
  medidas_control TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_iperc_linea_base_items_tenant ON iperc_linea_base_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_iperc_linea_base_items_linea_base ON iperc_linea_base_items(linea_base_id);

-- ── Extensión de ipercs/iperc_items para Continuo + Específico unificados ──
DO $$ BEGIN
  ALTER TABLE ipercs ADD COLUMN tipo VARCHAR(20) NOT NULL DEFAULT 'continuo';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE ipercs ADD CONSTRAINT ipercs_tipo_check CHECK (tipo IN ('continuo', 'especifico'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE ipercs ADD COLUMN linea_base_id INTEGER REFERENCES iperc_lineas_base(id);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE ipercs ADD COLUMN tarea_especifica VARCHAR(300);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE iperc_items ADD COLUMN linea_base_item_id INTEGER REFERENCES iperc_linea_base_items(id);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── Row-Level Security en las tablas nuevas ─────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['iperc_lineas_base', 'iperc_linea_base_items'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I
           USING (tenant_id = current_setting(''app.tenant_id'')::uuid)
           WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)',
        t
      );
    END IF;
  END LOOP;
END $$;
