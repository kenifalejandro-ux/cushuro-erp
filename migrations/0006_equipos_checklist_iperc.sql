-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: Equipos, Checklist de pre-uso e IPERC continuo
--
-- Primer módulo de negocio real sobre los cimientos técnicos (auth,
-- multi-tenant, RLS, roles) ya cerrados. tenant_id en TODAS las tablas
-- desde el día uno, incluidas las tablas "hijas" de detalle (items) — no
-- solo el header — así RLS aplica parejo en todo sin depender de que cada
-- query recuerde hacer JOIN hasta la tabla padre para heredar el filtro.
--
-- EJECUTAR (después de 0001, depende de tenants/usuarios):
--   psql -d mincoreerp -f migrations/0006_equipos_checklist_iperc.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Equipos (vehículos, maquinaria) ─────────────────────────────────────
-- Entidad nueva, distinta de repuestos (que es inventario de partes).
CREATE TABLE IF NOT EXISTS equipos (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  placa_codigo VARCHAR(50) NOT NULL,
  tipo         VARCHAR(100) NOT NULL,
  marca        VARCHAR(100),
  modelo       VARCHAR(100),
  activo       BOOLEAN NOT NULL DEFAULT true,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- la placa/código es única DENTRO de un tenant, no globalmente
  UNIQUE (tenant_id, placa_codigo)
);

CREATE INDEX IF NOT EXISTS idx_equipos_tenant ON equipos(tenant_id);

-- ── Checklist de pre-uso ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS checklist_plantillas (
  id          SERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  nombre      VARCHAR(150) NOT NULL,
  -- si no es NULL, esta plantilla aplica a todos los equipos de ese tipo
  -- (ej. "Camioneta"); si es NULL, es de uso general
  tipo_equipo VARCHAR(100),
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checklist_plantillas_tenant ON checklist_plantillas(tenant_id);

CREATE TABLE IF NOT EXISTS checklist_plantilla_items (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  plantilla_id INTEGER NOT NULL REFERENCES checklist_plantillas(id) ON DELETE CASCADE,
  descripcion  VARCHAR(300) NOT NULL,
  orden        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_checklist_plantilla_items_tenant ON checklist_plantilla_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_checklist_plantilla_items_plantilla ON checklist_plantilla_items(plantilla_id);

CREATE TABLE IF NOT EXISTS checklists (
  id                      SERIAL PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  equipo_id               INTEGER NOT NULL REFERENCES equipos(id),
  plantilla_id            INTEGER NOT NULL REFERENCES checklist_plantillas(id),
  usuario_id              UUID NOT NULL REFERENCES usuarios(id),
  fecha                   DATE NOT NULL DEFAULT CURRENT_DATE,
  turno                   VARCHAR(20),
  resultado               VARCHAR(20) NOT NULL DEFAULT 'bien',
  observaciones_generales TEXT,
  creado_en               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checklists_tenant ON checklists(tenant_id);
CREATE INDEX IF NOT EXISTS idx_checklists_equipo ON checklists(equipo_id);

CREATE TABLE IF NOT EXISTS checklist_items (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  -- copiado de la plantilla al momento de llenar el checklist, no referenciado
  -- en vivo: si la plantilla cambia después, el historial no se reescribe solo
  descripcion  VARCHAR(300) NOT NULL,
  estado       VARCHAR(10) NOT NULL,
  observacion  TEXT,
  CONSTRAINT checklist_items_estado_check CHECK (estado IN ('bien', 'malo', 'na'))
);

CREATE INDEX IF NOT EXISTS idx_checklist_items_tenant ON checklist_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist ON checklist_items(checklist_id);

-- ── IPERC continuo ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ipercs (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  fecha        DATE NOT NULL DEFAULT CURRENT_DATE,
  turno        VARCHAR(20),
  area_frente  VARCHAR(200) NOT NULL,
  equipo_id    INTEGER REFERENCES equipos(id),
  usuario_id   UUID NOT NULL REFERENCES usuarios(id),
  estado       VARCHAR(20) NOT NULL DEFAULT 'borrador',
  aprobado_por UUID REFERENCES usuarios(id),
  aprobado_en  TIMESTAMPTZ,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipercs_estado_check CHECK (estado IN ('borrador', 'aprobado', 'rechazado'))
);

CREATE INDEX IF NOT EXISTS idx_ipercs_tenant ON ipercs(tenant_id);

CREATE TABLE IF NOT EXISTS iperc_items (
  id              SERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  iperc_id        INTEGER NOT NULL REFERENCES ipercs(id) ON DELETE CASCADE,
  etapa_actividad VARCHAR(300) NOT NULL,
  peligro         VARCHAR(300) NOT NULL,
  riesgo          VARCHAR(300) NOT NULL,
  probabilidad    SMALLINT NOT NULL CHECK (probabilidad BETWEEN 1 AND 4),
  severidad       SMALLINT NOT NULL CHECK (severidad BETWEEN 1 AND 4),
  -- calculado por la propia BD: imposible que quede desincronizado de
  -- probabilidad*severidad por un bug en el código de la app
  nivel_riesgo    SMALLINT GENERATED ALWAYS AS (probabilidad * severidad) STORED,
  medidas_control TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_iperc_items_tenant ON iperc_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_iperc_items_iperc ON iperc_items(iperc_id);

-- ── Row-Level Security ───────────────────────────────────────────────────
-- FORCE es imprescindible: sin él, el owner de la tabla (el mismo usuario
-- con el que se conecta la app) queda exento de RLS por default, y la
-- política nunca aplicaría a las queries de la propia app.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'equipos',
    'checklist_plantillas', 'checklist_plantilla_items', 'checklists', 'checklist_items',
    'ipercs', 'iperc_items'
  ])
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
