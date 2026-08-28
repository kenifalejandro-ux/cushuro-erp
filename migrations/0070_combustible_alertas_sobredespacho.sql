-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: tipo de alerta 'sobredespacho' (Fase D)
--
-- Complemento de 0069, que agregó `equipos.capacidad_tanque`. Con ese dato
-- ya se puede detectar el caso del punto 5 del documento: se despacharon 48
-- gal a una unidad cuyo tanque es de 40.
--
-- ── No bloquea, marca ───────────────────────────────────────────────────
--
-- El vale se registra igual (201 Creado) y la alerta queda para revisar.
-- Bloquear dejaría a la excavadora sin combustible por una duda de dato, y
-- la explicación más probable NO es fraude: puede haberse llenado también
-- un bidón para la motobomba en el mismo vale, o la capacidad cargada en el
-- sistema puede estar mal. Producción parada por un posible error de
-- tipeo es peor que la duda que se quería resolver.
--
-- Es la misma regla que ya sigue el resto del módulo: el sistema bloquea
-- cuando el vale se contradice a SÍ MISMO (contómetro vs. cantidad, vale
-- duplicado); nunca cuando la duda depende de OTRA fila -- eso se marca y
-- se revisa (ver el punto 5 de docs/architecture/control-de-combustible.md).
--
-- EJECUTAR (después de 0069):
--   psql -d mincoreerp -f migrations/0070_combustible_alertas_sobredespacho.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- El CHECK de 0068 enumera los tipos válidos, así que sumar uno obliga a
-- reemplazarlo entero -- Postgres no permite "extender" un CHECK existente.
ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;

ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_tipo_check
  CHECK (tipo IN ('hueco_detectado', 'vale_anulado', 'sobredespacho'));
