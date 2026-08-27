-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: catálogo de grifos + historial de precios + costo por despacho
--
-- Kenif comparó el formulario de despacho contra su planilla real
-- (COMBUSTIBLE_2026_SANTA ISABEL.xlsx) y notó que faltaban C.U (costo
-- unitario), C.TOTAL y OBSERVACIONES. El precio de cada grifo en Perú es
-- distinto porque están franquiciados (el grifo de planta no cobra lo
-- mismo que un PRIMAX en la ruta a Bambamarca) -- así que el precio se
-- engancha al tanque propio o al grifo externo, no solo al tipo de
-- combustible.
--
-- Consecuencia de diseño: `grifo_externo` (texto libre desde 0062) deja de
-- alcanzar -- no se puede enganchar un precio de forma confiable a un
-- string tipeado a mano ("PRIMAX" hoy, "Primax Bambamarca" mañana). Pasa a
-- ser `grifo_id`, FK a un catálogo nuevo (`combustible_grifos`). El tanque
-- propio NO necesita catálogo nuevo: ya es una fila de `combustible`
-- (Fase A).
--
-- El precio se apila, nunca se pisa (`combustible_precios`) -- y un precio
-- mal cargado se anula con motivo, igual que las lecturas de tanque
-- (migración 0058), nunca se borra ni se edita.
--
-- El costo_unitario que queda en CADA despacho es una foto del momento en
-- que se cargó -- no se recalcula si el catálogo cambia después. El
-- autocompletado (buscar el precio vigente a la fecha del despacho) es
-- responsabilidad del frontend, antes de armar el POST -- este endpoint
-- no vuelve a resolver ningún precio por su cuenta.
--
-- EJECUTAR (después de 0062):
--   psql -d mincoreerp -f migrations/0063_combustible_precios.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── combustible_grifos ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS combustible_grifos (
  id         SERIAL PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  nombre     VARCHAR(150) NOT NULL,
  activo     BOOLEAN NOT NULL DEFAULT true,
  -- Nullable a propósito: un usuario borrado no debe borrar el catálogo --
  -- mismo criterio que combustible_lecturas.usuario_id.
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_grifos_nombre_tenant_unique'
  ) THEN
    ALTER TABLE combustible_grifos
      ADD CONSTRAINT combustible_grifos_nombre_tenant_unique UNIQUE (tenant_id, nombre);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_combustible_grifos_tenant ON combustible_grifos(tenant_id);

CREATE INDEX IF NOT EXISTS idx_combustible_grifos_usuario
  ON combustible_grifos(usuario_id) WHERE usuario_id IS NOT NULL;

ALTER TABLE combustible_grifos ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_grifos FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_grifos' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_grifos
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── Backfill: los grifo_externo que ya existan se vuelven catálogo ───────
-- Toca filas de TODOS los tenants -- no hay un único app.tenant_id de
-- sesión que fijar (mismo escenario que el backfill de 0045/0057).
ALTER TABLE combustible_grifos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despachos NO FORCE ROW LEVEL SECURITY;

INSERT INTO combustible_grifos (tenant_id, nombre)
SELECT DISTINCT tenant_id, grifo_externo
FROM combustible_despachos
WHERE grifo_externo IS NOT NULL
ON CONFLICT (tenant_id, nombre) DO NOTHING;

-- ── combustible_despachos: grifo_id reemplaza a grifo_externo ────────────
ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS grifo_id INTEGER REFERENCES combustible_grifos(id);

UPDATE combustible_despachos d
SET grifo_id = g.id
FROM combustible_grifos g
WHERE d.grifo_externo IS NOT NULL
  AND d.tenant_id = g.tenant_id
  AND d.grifo_externo = g.nombre
  AND d.grifo_id IS NULL;

-- Los dos CHECK de forma de 0062 mencionan grifo_externo -- hay que
-- soltarlos antes de poder borrar la columna, y se recrean más abajo
-- apuntando a grifo_id.
ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_forma_tanque_propio_check;
ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_forma_compra_externa_check;

ALTER TABLE combustible_despachos DROP COLUMN IF EXISTS grifo_externo;

-- ── combustible_despachos: costo_unitario + observaciones ────────────────
-- Nullable primero + backfill, mismo patrón que 0057: los despachos que ya
-- existían son de ANTES de esta migración, nunca capturaron costo -- 0,00
-- es honesto ("no se sabe, es de antes de este campo"), no "salió gratis".
ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS costo_unitario NUMERIC(10,4);

UPDATE combustible_despachos SET costo_unitario = 0 WHERE costo_unitario IS NULL;

ALTER TABLE combustible_despachos
  ALTER COLUMN costo_unitario SET NOT NULL;

ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS observaciones TEXT;

ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_grifos FORCE ROW LEVEL SECURITY;

-- Forma completa de tanque_propio, ahora con grifo_id en vez de
-- grifo_externo -- ver el original en 0062.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_forma_tanque_propio_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_forma_tanque_propio_check
      CHECK (
        origen <> 'tanque_propio' OR (
          combustible_id IS NOT NULL
          AND lectura_contometro IS NOT NULL
          AND grifo_id IS NULL
          AND lectura_horometro IS NULL
          AND lectura_odometro IS NULL
          AND horas_abastecidas IS NULL
        )
      );
  END IF;
END $$;

-- Forma completa de compra_externa -- a diferencia de 0062, ahora SÍ exige
-- grifo_id NOT NULL (el texto libre de antes nunca lo forzó a nivel de
-- base, dependía solo de Zod; con catálogo real no hay motivo para seguir
-- permitiendo el hueco).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_forma_compra_externa_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_forma_compra_externa_check
      CHECK (
        origen <> 'compra_externa' OR (
          combustible_id IS NULL
          AND lectura_contometro IS NULL
          AND grifo_id IS NOT NULL
          AND horas_abastecidas IS NOT NULL
          AND (
            (lectura_horometro IS NOT NULL AND lectura_odometro IS NULL)
            OR (lectura_horometro IS NULL AND lectura_odometro IS NOT NULL)
          )
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_combustible_despachos_grifo
  ON combustible_despachos(grifo_id) WHERE grifo_id IS NOT NULL;

-- ── combustible_precios ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS combustible_precios (
  id               SERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  tipo_combustible VARCHAR(20) NOT NULL,
  -- Exactamente uno de los dos, según a qué se le está fijando precio --
  -- mismo patrón polimórfico que el destino de un despacho (0062).
  combustible_id   INTEGER REFERENCES combustible(id),
  grifo_id         INTEGER REFERENCES combustible_grifos(id),
  precio_unitario  NUMERIC(10,4) NOT NULL,
  -- Desde cuándo rige -- se busca "el más reciente <= la fecha del
  -- despacho", nunca "el más reciente a secas": un vale offline que llega
  -- tarde tiene que resolver el precio de SU fecha, no el de hoy.
  vigente_desde    TIMESTAMPTZ NOT NULL,
  usuario_id       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Anulación -- mismo mecanismo que combustible_lecturas (0058): un precio
  -- mal tipeado nunca se borra ni se edita, se marca con motivo obligatorio
  -- y la fila queda como evidencia. El precio "vigente" ignora las filas
  -- anuladas y cae a la anterior válida.
  anulada_en       TIMESTAMPTZ,
  anulada_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_anulacion TEXT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_precios_tipo_combustible_check'
  ) THEN
    ALTER TABLE combustible_precios
      ADD CONSTRAINT combustible_precios_tipo_combustible_check
      CHECK (tipo_combustible IN ('diesel_b5', 'gasolina_90', 'glp'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_precios_destino_check'
  ) THEN
    ALTER TABLE combustible_precios
      ADD CONSTRAINT combustible_precios_destino_check
      CHECK (
        (combustible_id IS NOT NULL AND grifo_id IS NULL)
        OR (combustible_id IS NULL AND grifo_id IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_precios_precio_unitario_check'
  ) THEN
    ALTER TABLE combustible_precios
      ADD CONSTRAINT combustible_precios_precio_unitario_check CHECK (precio_unitario > 0);
  END IF;
END $$;

-- Cubre "el precio vigente para este tanque/grifo + tipo_combustible, a
-- una fecha dada, que no esté anulado" -- la consulta central de este
-- catálogo.
CREATE INDEX IF NOT EXISTS idx_combustible_precios_combustible
  ON combustible_precios(tenant_id, combustible_id, tipo_combustible, vigente_desde DESC)
  WHERE combustible_id IS NOT NULL AND anulada_en IS NULL;

CREATE INDEX IF NOT EXISTS idx_combustible_precios_grifo
  ON combustible_precios(tenant_id, grifo_id, tipo_combustible, vigente_desde DESC)
  WHERE grifo_id IS NOT NULL AND anulada_en IS NULL;

-- Mismo criterio que combustible_lecturas.usuario_id/anulada_por (0045,
-- 0058) -- cobertura de índice para toda FK, aunque nadie la consulte
-- todavía por sí sola (ver tests/db-index-coverage.test.ts).
CREATE INDEX IF NOT EXISTS idx_combustible_precios_usuario
  ON combustible_precios(usuario_id) WHERE usuario_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_combustible_precios_anulada_por
  ON combustible_precios(anulada_por) WHERE anulada_por IS NOT NULL;

ALTER TABLE combustible_precios ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_precios FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_precios' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_precios
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
