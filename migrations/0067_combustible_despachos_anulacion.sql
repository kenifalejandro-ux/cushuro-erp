-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: anulación de despachos (Fase D, primera entrega)
--
-- Es el punto 3 de docs/architecture/control-de-combustible.md, el único de
-- los cinco que seguía sin implementar: "Talonarios: hace falta una válvula
-- de escape".
--
-- El caso del documento: a Juan se le vuelca diésel encima del vale 00025 y
-- queda ilegible. Sin forma de rendirlo, el sistema dispara "vale no
-- registrado -- posible despacho no declarado" cada vez. A la cuarta, Juan
-- --que es honesto-- carga un 00025 inventado para que la secuencia cierre y
-- lo dejen en paz: el control diseñado para detectar fraude acabó de fabricar
-- un despacho falso.
--
-- Mismo mecanismo que ya se aplicó tres veces en este módulo: lecturas
-- (0058), precios (0063) y recepciones (0064). No se borra ni se edita
-- nunca: se marca, con motivo obligatorio, y la fila queda como evidencia.
--
-- ── Va PRIMERO dentro de la Fase D, y no es casualidad ──────────────────
--
-- El motor de conciliación suma despachos. Si un vale mal cargado no se
-- puede anular, la conciliación corre sobre datos que ya se sabe que están
-- mal, y el resultado es un faltante fantasma que nadie puede explicar.
--
-- ── La unicidad pasa a ser PARCIAL, y ese es el cambio de fondo ─────────
--
-- Hasta acá `UNIQUE (tenant_id, serie_talonario, n_vale)` cubría todas las
-- filas. Con anulación eso deja un caso sin salida: Juan carga el vale 00022
-- con 53 gal en vez de 35, lo anula... y ya no puede volver a registrar el
-- MISMO vale físico con el número correcto.
--
-- El resultado sería peor que el problema: anular un vale mal tipeado
-- BORRARÍA del sistema un despacho que sí ocurrió. El combustible salió del
-- tanque y el sistema dejaría de saberlo -- exactamente la fuga que este
-- módulo existe para detectar, causada por el propio mecanismo de
-- corrección. Y de paso el papel y el sistema quedarían contando cosas
-- distintas sobre el vale 00022.
--
-- Con el índice parcial:
--   - dos vales 00022 VIGENTES siguen dando 409 (el duplicado real del
--     punto 5, que es lo que hay que atajar);
--   - un 00022 anulado + un 00022 nuevo es válido: es la corrección.
--
-- No se pierde rastro: las anuladas nunca se borran, así que un número con
-- tres anulaciones y una vigente queda visible como tal -- y ese patrón, si
-- se repite, es en sí mismo señal para la conciliación.
--
-- ── Lo que NO cambia ────────────────────────────────────────────────────
--
-- El hueco de talonario sigue viendo un vale anulado como RENDIDO, no como
-- hueco (`findHuecosTalonario` pregunta si existe la fila, sin mirar su
-- estado). Es justamente la válvula de escape del punto 3: una vez que hay
-- salida legítima para un vale roto, un hueco de verdad --sin despacho y sin
-- anulación-- ya no tiene excusa.
--
-- EJECUTAR (después de 0066):
--   psql -d mincoreerp -f migrations/0067_combustible_despachos_anulacion.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_despachos
  -- NULL = despacho vigente. Misma bandera que el resto del módulo: guarda
  -- la marca Y el cuándo en una sola columna, sin poder quedar en un estado
  -- incoherente (anulada = true con fecha vacía).
  ADD COLUMN IF NOT EXISTS anulada_en TIMESTAMPTZ,
  -- Nullable a propósito: un usuario borrado no debe borrar la evidencia de
  -- quién anuló (mismo criterio que usuario_id en 0062).
  ADD COLUMN IF NOT EXISTS anulada_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS motivo_anulacion TEXT;

-- El motivo es OBLIGATORIO cuando hay anulación -- es lo único que distingue
-- "se mojó con diésel" de "estoy borrando un vale que no me conviene". A
-- nivel de base y no solo de Zod: un INSERT/UPDATE directo (script de
-- soporte, migración futura) tampoco puede dejar una anulación sin razón.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_anulacion_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_anulacion_check
      CHECK (
        (anulada_en IS NULL AND anulada_por IS NULL AND motivo_anulacion IS NULL)
        OR (anulada_en IS NOT NULL AND length(trim(motivo_anulacion)) > 0)
      );
  END IF;
END $$;

-- ── Unicidad: de constraint total a índice parcial sobre las vigentes ────
-- Ver el comentario largo del encabezado. El constraint viejo de 0062 se
-- suelta y se reemplaza por un índice único parcial, que es la única forma
-- de expresar "único entre las vigentes" en Postgres (un UNIQUE constraint
-- no admite WHERE).
ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_vale_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_combustible_despachos_vale_vigente
  ON combustible_despachos(tenant_id, serie_talonario, n_vale)
  WHERE anulada_en IS NULL;

-- ── Índices ─────────────────────────────────────────────────────────────

-- "Los despachos VIGENTES de este tanque en un rango de fechas" es la
-- consulta del motor de conciliación (Fase D) y la que ya usa la columna
-- "Diferencia" del historial de recepciones (0066). Parcial porque las
-- anuladas son la excepción y esas consultas las ignoran por definición.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_vigentes
  ON combustible_despachos(combustible_id, despachado_en)
  WHERE anulada_en IS NULL AND combustible_id IS NOT NULL;

-- Cobertura de FK: borrar un usuario dispara el ON DELETE SET NULL sobre
-- esta columna, y sin índice Postgres tendría que escanear la tabla entera
-- para validarlo (ver docs/architecture/database-performance-guidelines.md;
-- tests/db-index-coverage.test.ts lo hace fallar en CI si falta). Parcial
-- por el mismo motivo que en 0058: las anulaciones son la excepción.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_anulada_por
  ON combustible_despachos(anulada_por) WHERE anulada_por IS NOT NULL;
