-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: saldo acumulado del ciclo + tanque que dejó de medirse
--
-- Los dos agujeros que aparecieron en la auditoría adversaria de 2026-09-06,
-- ambos demostrados ejecutándolos contra la API, no leyendo código. Son los
-- únicos dos hallazgos que un atacante puede EXPLOTAR (el resto son de
-- auditoría o de presentación).
--
-- ── 1. Robo fraccionado: el descuadre por tramo no alcanza ──────────────
--
-- El balance de 0074 compara lectura contra lectura. Con el umbral en 1% de
-- un tanque de 20.000 (banda de 200 L), la simulación sacó 600 L en cuatro
-- tramos de 150 y **no generó una sola alerta**: cada tramo queda debajo de
-- la banda y nadie mira la suma.
--
-- Peor todavía, los tramos se COMPENSAN. En la prueba real de Kenif, el
-- último tramo dio +500 (sobrante) mientras el tanque estaba 1.000 L corto
-- desde que se llenó -- o sea que el correo que le llegó a gerencia decía
-- lo contrario de la verdad del período.
--
-- Este `descuadre_ciclo` mira el acumulado DESDE LA ÚLTIMA RECEPCIÓN. El
-- ciclo arranca cuando el tanque se carga porque es el único evento real y
-- documentado que "cierra" un período de consumo, y porque es el marco
-- mental con el que la gente ya piensa: "tenía 20.000, salieron 11.000,
-- deberían quedar 9.000".
--
-- El umbral es SEPARADO del de tramo, no el mismo número: el ruido honesto
-- de la varilla se acumula a lo largo del ciclo, así que reusar el 1% haría
-- que esta alerta gritara todos los días. Con tramo=1% y ciclo=2%, el robo
-- fraccionado de 600 L (3% del tanque) salta y cada tramo individual sigue
-- sin ruido.
--
-- ── 2. Dejar de medir apaga TODO el control ─────────────────────────────
--
-- La evasión más simple, y no requiere entender nada: no tomar la varilla.
-- La simulación despachó 10.000 L sin ninguna lectura posterior y no hubo
-- una sola alerta. Y no es solo el descuadre: la diferencia de recepción
-- (0066) también necesita una lectura después de la descarga, así que no
-- medir desactiva las dos detecciones de una.
--
-- `dias_sin_medir` va en `combustible_config` (por tenant) y no en el
-- tanque: es una política operativa -- cada cuánto la empresa exige que se
-- tome varilla -- no una propiedad física del recipiente. Default 3 días.
--
-- EJECUTAR (después de 0075):
--   psql -d mincoreerp -f migrations/0076_combustible_saldo_ciclo_y_sin_medir.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Umbral del ciclo, por tanque ────────────────────────────────────────

-- NULLABLE de entrada, con la semántica que fijó 0075: NULL = sin
-- configurar (no alertar), 0 = estricto, N = tolerar N% de la capacidad.
ALTER TABLE combustible
  ADD COLUMN IF NOT EXISTS umbral_descuadre_ciclo_pct NUMERIC(5,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_umbral_ciclo_pct_check'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_umbral_ciclo_pct_check
      CHECK (umbral_descuadre_ciclo_pct >= 0 AND umbral_descuadre_ciclo_pct <= 100);
  END IF;
END $$;

-- ── Plazo sin medir, por tenant ─────────────────────────────────────────

ALTER TABLE combustible_config
  ADD COLUMN IF NOT EXISTS dias_sin_medir INT NOT NULL DEFAULT 3;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_dias_sin_medir_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_dias_sin_medir_check
      CHECK (dias_sin_medir BETWEEN 1 AND 365);
  END IF;
END $$;

-- ── Tipos de alerta nuevos ──────────────────────────────────────────────

ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;

ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
    'descuadre_inventario', 'descuadre_ciclo', 'tanque_sin_medir'
  ));

-- `descuadre_ciclo` SÍ se congela: es combustible que nadie explicó en todo
-- un ciclo de carga, el hallazgo más fuerte que produce el módulo.
--
-- `tanque_sin_medir` NO se congela, igual que `nivel_bajo`: es una falla de
-- proceso que se arregla sola en cuanto alguien toma la varilla, y
-- convertirla en hallazgo permanente ensuciaría la tabla que debe contener
-- solo faltantes sin explicar.
ALTER TABLE combustible_anomalias
  DROP CONSTRAINT IF EXISTS combustible_anomalias_tipo_check;

ALTER TABLE combustible_anomalias
  ADD CONSTRAINT combustible_anomalias_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'sobredespacho', 'diferencia_recepcion',
    'medidor_inconsistente', 'descuadre_inventario', 'descuadre_ciclo'
  ));

-- ── Índice ──────────────────────────────────────────────────────────────

-- El worker de "sin medir" pregunta, por tanque activo, cuál fue su última
-- lectura vigente. Sin esto recorre todo el historial de lecturas del
-- tenant en cada corrida.
CREATE INDEX IF NOT EXISTS idx_combustible_lecturas_tanque_fecha
  ON combustible_lecturas(tenant_id, combustible_id, leido_en DESC)
  WHERE anulada_en IS NULL;
