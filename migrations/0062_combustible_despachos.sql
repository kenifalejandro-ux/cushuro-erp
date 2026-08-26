-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: Fase B de control de combustible -- combustible_despachos
--
-- Ver docs/architecture/control-de-combustible.md (puntos 1, 2 y 5,
-- reescritos 2026-08-26) y la memoria de diseño de Fase B. Un despacho es
-- el vale digital: el N°VALE (dentro de su serie de talonario) es el único
-- mecanismo de secuencia -- el contómetro NO encadena entre vales (se
-- resetea a cero en cada despacho), así que solo sirve como chequeo
-- intra-vale (punto 5: lectura_contometro vs. cantidad declarada).
--
-- Dos orígenes con reglas de forma distintas, misma tabla (ver el punto
-- "Bambamarca/ruta SÍ entra en el alcance" de la memoria de diseño):
--   - tanque_propio (Huamachuco): sale de un `combustible_id` propio,
--     contómetro real, sin horómetro/odómetro/horas_abastecidas.
--   - compra_externa (ruta a Bambamarca, grifos de terceros): sin tanque
--     propio que descontar, sin contómetro (el comprobante de un grifo
--     ajeno no trae esa lectura -- confirmado con Kenif), pero con
--     horómetro U odómetro (según el tipo de equipo) + horas_abastecidas
--     como control principal, y el nombre del grifo externo.
--
-- `combustible_id` y `grifo_externo` no estaban en el prompt cerrado de
-- ejecución palabra por palabra, pero SÍ en la memoria de diseño previa
-- ("compra externa necesita GRIFO/proveedor y no tiene stock propio que
-- descontar"; el talonario "se administra por punto de abastecimiento") --
-- sin `combustible_id` un despacho de tanque_propio no sabría de qué
-- tanque salió, y sin `grifo_externo` se perdería el dato real de la
-- planilla (columna GRIFO: VELASQUEZ, PRIMAX).
--
-- EJECUTAR (después de 0061):
--   psql -d mincoreerp -f migrations/0062_combustible_despachos.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── equipos.tipo_medidor ─────────────────────────────────────────────────
-- Qué instrumento mide ESTE equipo en compra_externa: horómetro (horas de
-- motor, ej. VOLQUETE) u odómetro (kilometraje, ej. TRAILER) -- nunca los
-- dos para el mismo equipo (ver hallazgo 9 de la memoria de columnas
-- reales). Nullable: la mayoría de los equipos (los que solo cargan en el
-- tanque propio) nunca necesitan este dato.
ALTER TABLE equipos ADD COLUMN IF NOT EXISTS tipo_medidor VARCHAR(20);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'equipos_tipo_medidor_check'
  ) THEN
    ALTER TABLE equipos
      ADD CONSTRAINT equipos_tipo_medidor_check
      CHECK (tipo_medidor IS NULL OR tipo_medidor IN ('horometro', 'odometro'));
  END IF;
END $$;

-- ── combustible_despachos ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS combustible_despachos (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id),

  origen              VARCHAR(20) NOT NULL,
  -- Tanque propio del que salió -- solo aplica a origen='tanque_propio'.
  -- Sin ON DELETE: mismo criterio que equipo_id de abajo y que el resto
  -- del ERP (checklists/ipercs/ordenes_trabajo) -- un punto de
  -- abastecimiento con despachos en su historial no se puede borrar.
  combustible_id      INTEGER REFERENCES combustible(id),
  -- Ticket de un grifo de terceros (VELASQUEZ, PRIMAX...) -- solo aplica a
  -- origen='compra_externa'. Texto libre a propósito: a diferencia de
  -- tipo_combustible/tipo_destino (categorías fijas y pocas), el universo
  -- de grifos de terceros es abierto y no vale la pena mantenerlo como
  -- catálogo para esta fase.
  grifo_externo       VARCHAR(150),

  -- Mismo enum que combustible.tipo_combustible (Fase A) -- ver
  -- combustible_tipo_combustible_check en 0057.
  tipo_combustible    VARCHAR(20) NOT NULL,

  -- Destino polimórfico: a un equipo, o sin placa (planta/reserva en
  -- cubeta) -- ver hallazgo 1 de la memoria de columnas reales.
  tipo_destino        VARCHAR(20) NOT NULL,
  equipo_id           INTEGER REFERENCES equipos(id),

  -- El talonario -- único mecanismo real de secuencia (punto 2 reescrito).
  -- Reinicia por serie/mes, por eso la unicidad es sobre los dos juntos,
  -- nunca sobre n_vale solo.
  serie_talonario     VARCHAR(20) NOT NULL,
  n_vale              INTEGER NOT NULL,

  cantidad            NUMERIC(12,2) NOT NULL,

  -- Chequeo intra-vale (punto 5): el aparato resetea a 0,0 en cada
  -- despacho, así que esta lectura es la cantidad que marcó ESE despacho
  -- puntual, tipeada aparte de `cantidad` para poder compararlas. Solo
  -- existe en tanque_propio -- un grifo ajeno no la incluye en su boleta.
  lectura_contometro  NUMERIC(12,2),

  -- Control principal en compra_externa (ver hallazgo 9): exactamente uno
  -- de los dos según equipos.tipo_medidor, + horas_abastecidas siempre.
  lectura_horometro   NUMERIC(12,2),
  lectura_odometro    NUMERIC(12,2),
  horas_abastecidas   NUMERIC(10,2),

  -- Nullable a propósito: un usuario borrado no debe borrar el historial
  -- de despachos -- mismo criterio que combustible_lecturas.usuario_id.
  usuario_id          UUID REFERENCES usuarios(id) ON DELETE SET NULL,

  -- Cuándo se hizo el despacho en cancha, no cuándo llegó al servidor --
  -- el punto 2 depende de que el N°VALE (no este timestamp) ordene los
  -- vales; este campo solo sirve para la "consecuencia gratis" de
  -- comparar los dos órdenes.
  despachado_en       TIMESTAMPTZ NOT NULL,
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El mismo N°VALE no puede repetirse DENTRO de la misma serie de
-- talonario -- pero SÍ puede repetirse entre series distintas (un
-- talonario nuevo reinicia la numeración, ver hallazgo 6). Esta es la
-- unicidad detrás del 409 del punto 5.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_vale_unique'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_vale_unique
      UNIQUE (tenant_id, serie_talonario, n_vale);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_origen_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_origen_check
      CHECK (origen IN ('tanque_propio', 'compra_externa'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_tipo_combustible_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_tipo_combustible_check
      CHECK (tipo_combustible IN ('diesel_b5', 'gasolina_90', 'glp'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_tipo_destino_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_tipo_destino_check
      CHECK (tipo_destino IN ('equipo', 'planta', 'reserva_cubeta'));
  END IF;
END $$;

-- Destino polimórfico: equipo_id lleno si y solo si tipo_destino='equipo'.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_destino_equipo_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_destino_equipo_check
      CHECK ((tipo_destino = 'equipo') = (equipo_id IS NOT NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_cantidad_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_cantidad_check CHECK (cantidad > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_n_vale_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_n_vale_check CHECK (n_vale > 0);
  END IF;
END $$;

-- Forma completa de tanque_propio: tanque propio + lectura de contómetro
-- SIEMPRE, nunca ningún campo de compra_externa (grifo/horómetro/
-- odómetro/horas). Esto es la red de seguridad de la base para la forma
-- general -- NO puede validar que el horómetro/odómetro elegido coincida
-- con equipos.tipo_medidor de ESE equipo (un CHECK no hace lookup entre
-- tablas): esa parte queda exclusivamente en el service (ver
-- combustible.service.ts).
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
          AND grifo_externo IS NULL
          AND lectura_horometro IS NULL
          AND lectura_odometro IS NULL
          AND horas_abastecidas IS NULL
        )
      );
  END IF;
END $$;

-- Forma completa de compra_externa: sin tanque propio ni contómetro (el
-- grifo ajeno no lo da), con horas_abastecidas siempre y EXACTAMENTE uno
-- de horómetro/odómetro -- nunca los dos juntos para el mismo despacho
-- (ver hallazgo 9).
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
          AND horas_abastecidas IS NOT NULL
          AND (
            (lectura_horometro IS NOT NULL AND lectura_odometro IS NULL)
            OR (lectura_horometro IS NULL AND lectura_odometro IS NOT NULL)
          )
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_combustible_despachos_tenant
  ON combustible_despachos(tenant_id);

CREATE INDEX IF NOT EXISTS idx_combustible_despachos_combustible
  ON combustible_despachos(combustible_id) WHERE combustible_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_combustible_despachos_equipo
  ON combustible_despachos(equipo_id) WHERE equipo_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_combustible_despachos_usuario
  ON combustible_despachos(usuario_id) WHERE usuario_id IS NOT NULL;

-- Mismo criterio que combustible_lecturas (0045) y el resto de tablas
-- propias de un tenant: FORCE es imprescindible, si no el owner de la
-- tabla (el rol con el que se conecta la app) queda exento de RLS.
ALTER TABLE combustible_despachos ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_despachos' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_despachos
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
