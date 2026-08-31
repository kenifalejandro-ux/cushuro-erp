-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: alertas que NO son sobre un vale
--
-- Cierra los tres huecos que quedaron al revisar el sistema de alertas antes
-- de dar la Fase D por cerrada:
--
--   1. diferencia_recepcion   -- el proveedor facturó más de lo que descargó
--   2. medidor_inconsistente  -- el horómetro/odómetro no cierra con el anterior
--   3. nivel_bajo             -- el tanque cruzó su nivel mínimo
--
-- Los dos primeros son incoherencias con lo ya construido: la diferencia se
-- calcula desde la Fase C y hasta tiene un asistente de calibración de
-- umbral (0066), pero superarlo no avisaba a nadie -- solo se pintaba de
-- rojo en una tabla que alguien tenía que abrir. Y el medidor que no cierra
-- lo pide explícitamente el punto 5 del documento de diseño, que nunca se
-- implementó.
--
-- ── El supuesto que hay que romper ──────────────────────────────────────
--
-- `combustible_alertas` (0068) nació con `serie_talonario` y `n_vale`
-- NOT NULL: TODA alerta era sobre un vale, porque los cuatro tipos que
-- existían salían de un despacho. Dos de los tres nuevos no lo son -- la
-- diferencia es sobre una RECEPCIÓN y el nivel bajo sobre un TANQUE.
--
-- Así que las dos columnas pasan a nullable y se suman anclas alternativas.
-- Pero aflojar el NOT NULL sin más dejaría pasar una alerta sin NINGÚN
-- ancla: una fila que no se puede mostrar ("¿alerta de qué?") ni
-- investigar. De ahí el CHECK de abajo, que exige al menos una.
--
-- Es, además, el mismo supuesto que habría que romper para generalizar las
-- alertas a otros módulos (Documentos con vencimientos, Repuestos con stock
-- bajo). Esta migración no generaliza nada -- sigue todo dentro de
-- combustible -- pero deja el modelo listo para esa dirección.
--
-- EJECUTAR (después de 0072):
--   psql -d mincoreerp -f migrations/0073_combustible_alertas_operativas.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── combustible_alertas ─────────────────────────────────────────────────

ALTER TABLE combustible_alertas
  ALTER COLUMN serie_talonario DROP NOT NULL,
  ALTER COLUMN n_vale DROP NOT NULL;

ALTER TABLE combustible_alertas
  -- Ancla de nivel_bajo: el tanque que cruzó su mínimo. INT porque
  -- `combustible.id` es SERIAL (int), no BIGSERIAL -- acá los tipos sí
  -- coinciden.
  ADD COLUMN IF NOT EXISTS combustible_id INT REFERENCES combustible(id) ON DELETE CASCADE,
  -- Ancla de diferencia_recepcion: la entrega que vino corta. BIGINT
  -- porque `combustible_recepciones.id` es BIGSERIAL -- ver abajo.
  ADD COLUMN IF NOT EXISTS recepcion_id BIGINT REFERENCES combustible_recepciones(id) ON DELETE CASCADE;

-- ── Por qué CASCADE acá y SET NULL en despacho_id ───────────────────────
--
-- `despacho_id` puede quedar en NULL sin drama: esas alertas llevan su
-- propio ancla (serie + n_vale del vale), así que sobreviven perfectamente
-- a que el despacho desaparezca.
--
-- Estas dos NO: una alerta de nivel bajo se ancla ÚNICAMENTE al tanque, y
-- una de diferencia únicamente a la recepción. Con SET NULL, borrar el
-- tanque dejaría la alerta sin ancla ninguna -- y el CHECK de abajo, que
-- exige al menos una, rechazaría ese mismo UPDATE implícito. El borrado
-- fallaría con un error de constraint imposible de explicar desde afuera
-- (lo encontró el helper que limpia tenants en los tests).
--
-- CASCADE además es lo correcto en el fondo: "el tanque X está por debajo
-- de su mínimo" no significa nada si el tanque X ya no existe.

-- ── Corrección de tipo: despacho_id era INT contra una PK BIGINT ────────
--
-- `combustible_alertas.despacho_id` (migración 0068) y el `recepcion_id`
-- de arriba apuntan a tablas cuya PK es BIGSERIAL, pero se declararon INT.
-- Postgres acepta la FK igual, así que nada falló a la vista -- pero el
-- desajuste tiene dos consecuencias reales:
--
--  1. Un id por encima de 2.147.483.647 no entraría en la columna.
--  2. Y esta es la que muerde YA: el driver de node devuelve BIGINT como
--     STRING y INT como NUMBER, para no perder precisión. Con los tipos
--     cruzados, el mismo id llega como "702" desde la recepción y como 702
--     desde la alerta, y cualquier comparación entre los dos falla en
--     silencio. Lo encontró un test que buscaba la alerta de una recepción
--     por id y no la hallaba, con la fila existiendo en la base.
--
-- Con las dos como BIGINT, los dos lados llegan como string y comparan bien.
--
-- El BEGIN/COMMIT y el `SET LOCAL` no son decorativos: cambiar el tipo de
-- una columna reescribe la tabla, y estas dos tienen RLS **forzado** con
-- una policy que hace `current_setting('app.tenant_id')::uuid` sin
-- `missing_ok`. El runner de migraciones no abre transacción ni setea ese
-- parámetro (no es de ningún tenant en particular), así que sin esto el
-- ALTER falla con `unrecognized configuration parameter "app.tenant_id"`.
-- El UUID de abajo es un relleno para que la expresión evalúe: el rewrite
-- es DDL y toca todas las filas físicas, sin filtrar por la policy.
BEGIN;
SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000';

ALTER TABLE combustible_alertas
  ALTER COLUMN despacho_id TYPE BIGINT;

ALTER TABLE combustible_anomalias
  ALTER COLUMN despacho_id TYPE BIGINT;

COMMIT;

-- Toda alerta tiene que poder responder "¿sobre qué es?". Sin esto, aflojar
-- el NOT NULL de arriba permitiría filas imposibles de mostrar.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_alertas_ancla_check'
  ) THEN
    ALTER TABLE combustible_alertas
      ADD CONSTRAINT combustible_alertas_ancla_check
      CHECK (
        (serie_talonario IS NOT NULL AND n_vale IS NOT NULL)
        OR combustible_id IS NOT NULL
        OR recepcion_id IS NOT NULL
      );
  END IF;
END $$;

-- Postgres no permite extender un CHECK: se reemplaza entero.
ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;

ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente'
  ));

-- Cobertura de FK (tests/db-index-coverage.test.ts lo exige).
CREATE INDEX IF NOT EXISTS idx_combustible_alertas_combustible
  ON combustible_alertas(combustible_id) WHERE combustible_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_combustible_alertas_recepcion
  ON combustible_alertas(recepcion_id) WHERE recepcion_id IS NOT NULL;

-- La consulta de deduplicación de nivel_bajo: "¿este tanque ya tiene una
-- alerta de nivel abierta?". Sin esto, cada lectura con el tanque por
-- debajo del mínimo generaría una alerta nueva y el control moriría por
-- ruidoso -- el riesgo que nombra el punto 4 del documento.
CREATE INDEX IF NOT EXISTS idx_combustible_alertas_nivel_abierto
  ON combustible_alertas(tenant_id, combustible_id)
  WHERE tipo = 'nivel_bajo' AND resuelta_en IS NULL;

-- La consulta del worker para no re-alertar la misma recepción.
CREATE INDEX IF NOT EXISTS idx_combustible_alertas_recepcion_tipo
  ON combustible_alertas(tenant_id, recepcion_id)
  WHERE tipo = 'diferencia_recepcion';

-- ── combustible_anomalias ───────────────────────────────────────────────
-- Mismo tratamiento: una anomalía congelada de diferencia_recepcion tampoco
-- tiene vale. `nivel_bajo` NO entra en el CHECK de tipos a propósito -- ver
-- abajo.

ALTER TABLE combustible_anomalias
  ALTER COLUMN serie_talonario DROP NOT NULL,
  ALTER COLUMN n_vale DROP NOT NULL;

-- Mismo criterio de CASCADE que en combustible_alertas -- ver arriba.
ALTER TABLE combustible_anomalias
  ADD COLUMN IF NOT EXISTS combustible_id INT REFERENCES combustible(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS recepcion_id BIGINT REFERENCES combustible_recepciones(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_anomalias_ancla_check'
  ) THEN
    ALTER TABLE combustible_anomalias
      ADD CONSTRAINT combustible_anomalias_ancla_check
      CHECK (
        (serie_talonario IS NOT NULL AND n_vale IS NOT NULL)
        OR combustible_id IS NOT NULL
        OR recepcion_id IS NOT NULL
      );
  END IF;
END $$;

ALTER TABLE combustible_anomalias
  DROP CONSTRAINT IF EXISTS combustible_anomalias_tipo_check;

ALTER TABLE combustible_anomalias
  ADD CONSTRAINT combustible_anomalias_tipo_check
  -- `nivel_bajo` queda AFUERA a propósito: es operativo, no un faltante.
  -- Se arregla reponiendo combustible, y congelar "el tanque estuvo bajo el
  -- martes" como hallazgo permanente ensuciaría la tabla que debe contener
  -- solo lo que nadie pudo explicar. `despacho_tardio` tampoco: es un aviso
  -- que se revisa y se cierra.
  CHECK (tipo IN (
    'hueco_detectado', 'sobredespacho', 'diferencia_recepcion', 'medidor_inconsistente'
  ));

CREATE INDEX IF NOT EXISTS idx_combustible_anomalias_combustible
  ON combustible_anomalias(combustible_id) WHERE combustible_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_combustible_anomalias_recepcion
  ON combustible_anomalias(recepcion_id) WHERE recepcion_id IS NOT NULL;
