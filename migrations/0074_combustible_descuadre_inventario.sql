-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: descuadre de inventario (el control central que faltaba)
--
-- Hasta acá el módulo vigilaba las dos puntas por separado y ninguna las
-- cruzaba:
--
--   - ENTRADA: `diferencia_litros` (0066) compara lo que facturó el
--     proveedor contra lo que subió el tanque en esa descarga.
--   - SALIDA: nada. Los vales se registran, el nivel se mide, y nadie
--     preguntaba si un número explica al otro.
--
-- Encontrado simulando el flujo completo: se cargaron 4.000 L en vales, el
-- tanque bajó 4.500 L, y el sistema no dijo absolutamente nada. Los siete
-- tipos de alerta existentes (hueco de talonario, vale anulado,
-- sobredespacho, despacho tardío, diferencia de recepción, nivel bajo,
-- medidor inconsistente) miran cada uno su propia fila; ninguno hace el
-- balance del tanque.
--
-- Y ese balance es literalmente la razón de ser del módulo: combustible que
-- salió del tanque sin que ningún papel lo explique.
--
-- ── La cuenta ───────────────────────────────────────────────────────────
--
--   esperado  = nivel_anterior + recepciones − despachos
--   descuadre = nivel_medido − esperado
--
-- entre dos lecturas de varilla consecutivas, contando solo los movimientos
-- vigentes del intervalo (los anulados no explican nada, por definición).
--
-- Las DOS direcciones son anomalía, y por eso se alertan las dos:
--
--   - NEGATIVO (falta): salió más de lo que los vales explican. Robo, fuga,
--     o despacho que nadie registró.
--   - POSITIVO (sobra): los vales dicen más de lo que realmente salió. Mal
--     tipeo, o combustible cargado en el papel a una máquina que nunca lo
--     recibió -- que es fraude igual, solo que del otro lado.
--
-- ── Por qué un umbral, y por qué arranca en 0 ───────────────────────────
--
-- La varilla no es un instrumento exacto: dilatación térmica, error de
-- lectura, tanque que no está perfectamente nivelado. Un tanque de 20.000 L
-- puede dar ±100 L de ruido honesto. Sin umbral, esto alertaría todos los
-- días y moriría por ruidoso -- el riesgo que nombra el punto 4 del
-- documento de diseño.
--
-- `umbral_descuadre_pct` arranca en 0 = NO ALERTAR TODAVÍA, exactamente el
-- mismo criterio que `umbral_diferencia_pct` (0066) y `capacidad_tanque`
-- (0069): sin historial propio del tanque no hay número defendible, y
-- inventar uno es peor que no medir. Se sube cuando el tanque ya tiene
-- lecturas suficientes para saber cuánto ruido produce.
--
-- EJECUTAR (después de 0073):
--   psql -d mincoreerp -f migrations/0074_combustible_descuadre_inventario.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Umbral por tanque ───────────────────────────────────────────────────

-- Va en el tanque y no en `combustible_config` (0071, que es por tenant)
-- porque el ruido de medición es propiedad FÍSICA de cada tanque: depende
-- de su forma, su varilla y dónde está instalado. Dos tanques del mismo
-- tenant pueden tolerar cosas muy distintas.
ALTER TABLE combustible
  ADD COLUMN IF NOT EXISTS umbral_descuadre_pct NUMERIC(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_umbral_descuadre_pct_check'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_umbral_descuadre_pct_check
      CHECK (umbral_descuadre_pct >= 0 AND umbral_descuadre_pct <= 100);
  END IF;
END $$;

-- ── Tipo de alerta nuevo ────────────────────────────────────────────────

-- Mismo procedimiento que 0070/0072/0073: Postgres no permite extender un
-- CHECK, hay que reemplazarlo entero.
ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;

ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
    'descuadre_inventario'
  ));

-- Se congela como anomalía a las 72h, igual que el hueco de talonario:
-- combustible que nadie pudo explicar en tres días es un hallazgo
-- permanente, no un aviso operativo que se cierra solo. A diferencia de
-- `nivel_bajo`, que sí queda fuera del CHECK de anomalías porque "el tanque
-- estuvo bajo el martes" no ensucia nada si se repone el miércoles.
ALTER TABLE combustible_anomalias
  DROP CONSTRAINT IF EXISTS combustible_anomalias_tipo_check;

ALTER TABLE combustible_anomalias
  ADD CONSTRAINT combustible_anomalias_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'sobredespacho', 'diferencia_recepcion',
    'medidor_inconsistente', 'descuadre_inventario'
  ));

-- ── Índice ──────────────────────────────────────────────────────────────

-- La consulta del intervalo pregunta "despachos vigentes de este tanque
-- entre dos instantes". Sin esto, cada lectura haría un scan de todos los
-- despachos del tenant -- y las lecturas son la operación más frecuente del
-- módulo cuando hay varios tanques.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_tanque_fecha
  ON combustible_despachos(tenant_id, combustible_id, despachado_en)
  WHERE anulada_en IS NULL;
