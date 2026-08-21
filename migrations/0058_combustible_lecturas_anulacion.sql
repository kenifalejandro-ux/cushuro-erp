-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: anulación de lecturas de combustible (con motivo obligatorio)
--
-- El problema: `combustible_lecturas` es append-only a propósito (0045) --
-- si una lectura se pudiera editar en silencio, alguien podría tapar una
-- fuga reescribiendo el número después. Pero un error de tipeo es real: el
-- grifero mide con la varilla, ve 19.000 y escribe 500. Hoy la única salida
-- es registrar otra lectura encima, lo que deja el número equivocado en el
-- historial ensuciando la variación (un -18.500 seguido de un +18.500 que
-- parece una fuga enorme y no lo es).
--
-- La solución es la MISMA que el diseño ya eligió para los vales rotos (ver
-- docs/architecture/control-de-combustible.md, punto 3): no se borra ni se
-- edita, se ANULA con motivo. La fila queda como evidencia de que hubo un
-- error, y deja de contar para el nivel y para la variación.
--
-- EJECUTAR (después de 0057):
--   psql -d mincoreerp -f migrations/0058_combustible_lecturas_anulacion.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_lecturas
  -- NULL = lectura vigente. Es la bandera que consulta todo lo demás, por
  -- eso se filtra por IS NULL y no por un booleano: guarda la marca Y el
  -- cuándo en una sola columna, sin poder quedar en un estado incoherente
  -- (anulada = true con fecha vacía).
  ADD COLUMN anulada_en TIMESTAMPTZ,
  -- Nullable a propósito: un usuario borrado no debe borrar la evidencia de
  -- la anulación (mismo criterio que `usuario_id` en 0045).
  ADD COLUMN anulada_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN motivo_anulacion TEXT;

-- El motivo es OBLIGATORIO cuando hay anulación -- es lo único que
-- distingue "me equivoqué al tipear" de "estoy borrando un número que no me
-- conviene". Sin él la válvula de escape no sirve como respaldo de nada.
-- A nivel de base y no solo de Zod: un INSERT/UPDATE directo (script de
-- soporte, migración futura) tampoco puede dejar una anulación sin razón.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_lecturas_anulacion_check'
  ) THEN
    ALTER TABLE combustible_lecturas
      ADD CONSTRAINT combustible_lecturas_anulacion_check
      CHECK (
        (anulada_en IS NULL AND anulada_por IS NULL AND motivo_anulacion IS NULL)
        OR (anulada_en IS NOT NULL AND length(trim(motivo_anulacion)) > 0)
      );
  END IF;
END $$;

-- "La última lectura VIGENTE de este tanque" es la consulta que corre en
-- cada anulación (para recalcular nivel_actual) y en cada listado del
-- historial. El índice parcial solo indexa las vigentes, que son la
-- mayoría abrumadora -- las anuladas son la excepción y no hace falta que
-- ocupen lugar acá.
CREATE INDEX IF NOT EXISTS idx_combustible_lecturas_vigentes
  ON combustible_lecturas(combustible_id, leido_en DESC)
  WHERE anulada_en IS NULL;
