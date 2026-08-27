-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: umbral de diferencia por tanque (preparación de Fase D)
--
-- La Fase C dejó registradas por separado las dos fuentes que hay que cruzar:
-- lo que el proveedor FACTURA (combustible_recepciones) y lo que la varilla
-- MIDE (combustible_lecturas). La resta entre ambas es lo que delata una
-- entrega corta:
--
--     (nivel_después − nivel_antes) + despachos_del_período − cantidad_facturada
--
-- Caso real que motivó esto (2026-08-27): 13.500 medidos + 6.000 facturados
-- = 19.500 esperados, varilla marcó 19.300 -> faltan 200 L (−3,3%).
--
-- ── Por qué un umbral, y por qué arranca en 0 ───────────────────────────
--
-- Parte de esa diferencia es legítima y no hay que alarmarse: la dilatación
-- térmica del diésel ronda 0,08–0,1% por °C (10 °C entre carga y descarga ya
-- son ~50 L en una entrega de 6.000), y la varilla tiene su propio error de
-- medición, peor en tanque cilíndrico horizontal. Todo junto, 1–2%. La
-- evaporación NO entra: el diésel casi no se evapora, a diferencia de la
-- gasolina.
--
-- Sin umbral, cada diferencia normal dispararía una alarma y en un mes nadie
-- mira más esa pantalla -- el control muere por ruidoso, que es el punto 4 de
-- docs/architecture/control-de-combustible.md.
--
-- DEFAULT 0 significa "no alertar todavía", no "tolerancia cero": hasta tener
-- historial propio, cualquier número sería inventado. El valor real lo va a
-- fijar el cliente (o el asistente de calibración de Fase D) sobre la muestra
-- acumulada.
--
-- ── La trampa que este umbral NO debe caer ──────────────────────────────
--
-- Cuando en Fase D se calibre desde el histórico, la muestra puede estar
-- CONTAMINADA: si entre esas recepciones ya hubo robos, calibrar sobre todas
-- ellas enseña al sistema a aceptar el robo como normal, y queda ciego para
-- siempre. Por eso el umbral se guarda como dato editable y auditable, nunca
-- como algo que una fórmula fija sola. Ver la memoria de diseño de Fase C.
--
-- EJECUTAR (después de 0065):
--   psql -d mincoreerp -f migrations/0066_combustible_umbral_diferencia.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Porcentaje de la cantidad recibida, no litros fijos: 200 L en una entrega
-- de 6.000 es grave, en una de 30.000 es ruido. Mismo criterio que
-- tolerancia_capacidad_pct (0064).
ALTER TABLE combustible
  ADD COLUMN IF NOT EXISTS umbral_diferencia_pct NUMERIC(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_umbral_diferencia_pct_check'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_umbral_diferencia_pct_check
      -- Techo de 100%: un umbral que tolere perder todo lo que entró no es un
      -- umbral, es apagar el control.
      CHECK (umbral_diferencia_pct >= 0 AND umbral_diferencia_pct <= 100);
  END IF;
END $$;
