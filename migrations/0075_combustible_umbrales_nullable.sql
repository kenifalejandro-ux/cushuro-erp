-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: los umbrales pasan a NULLABLE -- separar "sin configurar" de
-- "tolerancia cero"
--
-- Hasta acá, en los dos umbrales del módulo (`umbral_diferencia_pct` de
-- 0066 y `umbral_descuadre_pct` de 0074), el 0 significaba **"no alertar
-- todavía"**. Era una decisión consciente y está documentada en las dos
-- migraciones... pero deja un caso legítimo sin forma de expresarse:
--
--   "Quiero que me avise por CUALQUIER diferencia, aunque sea un litro."
--
-- El número que diría eso naturalmente -- 0 -- ya está ocupado significando
-- exactamente lo contrario. Lo levantó Kenif preguntando qué pasa si el
-- cliente pide tolerancia cero de verdad, y no había respuesta.
--
-- ── Lo irónico es que el módulo ya lo había resuelto bien ────────────────
--
-- La migración 0059 estableció que el nivel de un tanque sin lecturas es
-- NULL = DESCONOCIDO, nunca 0, justamente porque "no sé cuánto hay" y "medí
-- y da cero" son afirmaciones distintas y confundirlas hace mentir al
-- sistema. Los umbrales contradecían esa misma regla dentro del mismo
-- módulo.
--
-- Después de esta migración:
--
--   NULL  -> sin configurar, no alertar (lo que hoy dice el 0)
--   0     -> estricto: alertar por cualquier diferencia
--   1..100 -> tolerar hasta ese porcentaje
--
-- ── Por qué los dos umbrales juntos ─────────────────────────────────────
--
-- Arreglar solo uno dejaría dos campos con la misma pinta, en el mismo
-- formulario, donde el 0 significa cosas opuestas. Eso es peor que el
-- problema original: hoy al menos la regla es una sola, aunque sea la
-- incorrecta.
--
-- ── La conversión de datos ──────────────────────────────────────────────
--
-- Los 0 existentes pasan a NULL. No es una pérdida de información: hoy
-- TODOS los 0 guardados significan "sin configurar" (es el default y nadie
-- pudo haber querido decir otra cosa, porque la otra cosa no era
-- expresable). Convertirlos preserva el comportamiento exacto y hace
-- explícito lo que ya querían decir.
--
-- EJECUTAR (después de 0074):
--   psql -d mincoreerp -f migrations/0075_combustible_umbrales_nullable.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Gotcha de RLS forzado, la segunda vez que muerde (ver 0073) ─────────
--
-- `combustible` tiene RLS FORZADO y su policy hace
-- `current_setting('app.tenant_id')::uuid` sin `missing_ok`. El runner de
-- migraciones no setea ese parámetro, así que cualquier cosa que evalúe la
-- policy falla con `unrecognized configuration parameter`.
--
-- Y acá hay un agravante que 0073 no tuvo: la conversión de datos NO puede
-- ir como `UPDATE`. Aunque se setee el GUC en un tenant dummy para que la
-- policy no reviente, ese UPDATE quedaría filtrado a las filas de ESE
-- tenant -- ninguna -- y la migración diría que aplicó sin haber tocado
-- nada. Un no-op silencioso, que es peor que un error.
--
-- Por eso la conversión va como DDL (`ALTER COLUMN ... TYPE ... USING`,
-- mismo tipo, solo para forzar el rewrite): el rewrite recorre todas las
-- filas FÍSICAS de la tabla, sin pasar por la policy.
BEGIN;
SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000';

ALTER TABLE combustible
  ALTER COLUMN umbral_diferencia_pct DROP DEFAULT,
  ALTER COLUMN umbral_diferencia_pct DROP NOT NULL,
  ALTER COLUMN umbral_descuadre_pct DROP DEFAULT,
  ALTER COLUMN umbral_descuadre_pct DROP NOT NULL;

ALTER TABLE combustible
  ALTER COLUMN umbral_diferencia_pct TYPE NUMERIC(5,2)
    USING NULLIF(umbral_diferencia_pct, 0),
  ALTER COLUMN umbral_descuadre_pct TYPE NUMERIC(5,2)
    USING NULLIF(umbral_descuadre_pct, 0);

COMMIT;

-- Los CHECK de 0066 y 0074 (`>= 0 AND <= 100`) siguen sirviendo tal cual:
-- en SQL `NULL >= 0` da NULL, no FALSE, y un CHECK solo rechaza con FALSE
-- explícito. NULL pasa sin que haya que tocarlos.
