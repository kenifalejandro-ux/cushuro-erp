-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: vale cargado fuera de orden sin hueco que lo explique
--
-- Hallazgo #9 de la auditoría adversaria. La detección de huecos (0068) solo
-- mira HACIA ADELANTE: se dispara cuando llega un vale por encima del máximo
-- de su serie. Un vale que entra POR DEBAJO no genera nada.
--
-- Eso está bien cuando rellena un hueco ya alertado -- es el vale tardío que
-- sincronizó, y `resolverAlertaHuecoSiExiste` lo cierra solo. Pero la
-- simulación cargó el vale 7 en una serie cuyo máximo era 50, sin que jamás
-- hubiera existido una alerta por el 7, y entró en silencio absoluto.
--
-- Cómo se llega a ese estado: la serie estrenó en el 50 (el primer vale de
-- una serie nunca revela huecos, porque no hay contra qué comparar), y
-- después alguien cargó el 7. Ningún control lo mira.
--
-- Por qué importa: un talonario que se carga desordenado es exactamente el
-- síntoma de alguien reconstruyendo papeles a posteriori. No prueba nada por
-- sí solo -- por eso ALERTA y no bloquea, misma regla del punto 5 -- pero es
-- de las pocas señales que se tienen sobre el papel en sí.
--
-- No se congela como anomalía: es una señal de proceso sobre CÓMO se carga
-- el talonario, no un faltante de combustible. Se revisa a mano y se cierra
-- con motivo, como el vale anulado.
--
-- EJECUTAR (después de 0076):
--   psql -d mincoreerp -f migrations/0077_combustible_vale_fuera_de_orden.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;

ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
    'descuadre_inventario', 'descuadre_ciclo', 'tanque_sin_medir',
    'vale_fuera_de_orden'
  ));
