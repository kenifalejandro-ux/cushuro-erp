-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: Combustible pasa de "un medidor" a "punto de abastecimiento"
--
-- Fase A del módulo de control de combustible (ver
-- docs/architecture/control-de-combustible.md). Hasta acá un tanque solo
-- tenía tanque_nombre/capacidad_total/nivel_actual/fecha_actualizacion
-- (0002_business_tables.sql) y se cargaba directo en la base -- no existía
-- POST /, PUT /:id ni DELETE /:id (ver combustible.routes.ts). Esta
-- migración agrega las columnas que necesita un ABM real.
--
-- EJECUTAR (después de 0056):
--   psql -d mincoreerp -f migrations/0057_combustible_tanques.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Columnas con default constante ───────────────────────────────────────
-- Postgres 11+ no reescribe la tabla al agregar una columna NOT NULL con
-- default constante -- el valor se aplica sin tocar las filas existentes
-- fila por fila, mismo motivo por el que no hace falta backfill para
-- estas cinco.
ALTER TABLE combustible
  ADD COLUMN nivel_minimo       NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN totalizador_actual NUMERIC(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN costo_promedio     NUMERIC(12,4) NOT NULL DEFAULT 0,
  ADD COLUMN moneda             VARCHAR(3)    NOT NULL DEFAULT 'PEN',
  ADD COLUMN activo             BOOLEAN       NOT NULL DEFAULT true,
  ADD COLUMN ubicacion          VARCHAR(200);

-- costo_promedio nace acá pero se queda en 0/sin uso hasta la Fase C (motor
-- de recepciones con costo ponderado) -- el frontend de esta fase lo
-- excluye de los formularios de alta/edición a propósito.

-- ── Columnas sin default razonable: nullable primero, backfill, recién
--    ahí NOT NULL ─────────────────────────────────────────────────────────
-- Si esta migración corre sobre una tabla `combustible` con filas ya
-- cargadas (tanques de piloto, por ejemplo), un NOT NULL directo revienta
-- el ALTER TABLE apenas hay una fila sin valor para estas columnas. El
-- backfill de abajo cubre ese caso sin necesitar saber de antemano si la
-- tabla está vacía o no -- mismo patrón que el histórico de lecturas en
-- 0045_combustible_lecturas.sql.
ALTER TABLE combustible
  ADD COLUMN codigo           VARCHAR(50),
  ADD COLUMN tipo_combustible VARCHAR(20),
  ADD COLUMN unidad           VARCHAR(5),
  ADD COLUMN tipo_punto       VARCHAR(20);

-- El backfill toca filas de TODOS los tenants a la vez -- no hay un único
-- `app.tenant_id` de sesión que fijar (mismo escenario que el backfill de
-- 0045). `combustible` tiene FORCE ROW LEVEL SECURITY desde
-- 0005_rls_tenant_isolation.sql -- se desactiva para el dueño solo durante
-- el backfill y se reactiva antes de terminar, dentro de la misma
-- transacción implícita que migrate.ts abre para todo el archivo.
ALTER TABLE combustible NO FORCE ROW LEVEL SECURITY;

-- Valores por defecto conservadores para filas preexistentes: un código
-- derivado del id (único por construcción, así que no choca con el UNIQUE
-- de abajo) y diesel/gal/fijo como el caso más común de un tanque fijo de
-- planta. Quien haya cargado tanques de piloto puede corregirlos después
-- desde el ABM nuevo -- lo que importa acá es que la migración no falle.
UPDATE combustible
SET
  codigo = 'TQ-' || id::text,
  tipo_combustible = 'diesel_b5',
  unidad = 'gal',
  tipo_punto = 'fijo'
WHERE codigo IS NULL;

ALTER TABLE combustible FORCE ROW LEVEL SECURITY;

ALTER TABLE combustible
  ALTER COLUMN codigo           SET NOT NULL,
  ALTER COLUMN tipo_combustible SET NOT NULL,
  ALTER COLUMN unidad           SET NOT NULL,
  ALTER COLUMN tipo_punto       SET NOT NULL;

-- ── Constraints ───────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_codigo_tenant_unique'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_codigo_tenant_unique UNIQUE (tenant_id, codigo);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_tipo_combustible_check'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_tipo_combustible_check
      CHECK (tipo_combustible IN ('diesel_b5', 'gasolina_90', 'glp'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_unidad_check'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_unidad_check CHECK (unidad IN ('gal', 'L'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_tipo_punto_check'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_tipo_punto_check
      CHECK (tipo_punto IN ('fijo', 'cisterna', 'surtidor'));
  END IF;
END $$;

-- Corrige la división por cero de `nivel_actual / capacidad_total` en
-- combustible.repository.ts (findAll/findById) -- hasta acá capacidad_total
-- no tenía ninguna guarda a nivel de base.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_capacidad_total_check'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_capacidad_total_check CHECK (capacidad_total > 0);
  END IF;
END $$;
