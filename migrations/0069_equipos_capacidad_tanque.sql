-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: capacidad de tanque por equipo (habilita sobredespacho, Fase D)
--
-- Cierra la última decisión que quedaba abierta de la Fase D. El caso del
-- documento (punto 5 de docs/architecture/control-de-combustible.md):
--
--   "EX-04 tiene tanque de 40 gal, Juan despacha 48. Sospechoso, pero puede
--    haber llenado también un bidón para la motobomba, o la capacidad
--    cargada en el sistema estar mal -> 201 Creado + anomalía marcada."
--
-- Hasta ahora eso NO se podía detectar: `equipos` no tenía dónde guardar la
-- capacidad, así que no había contra qué comparar la cantidad despachada.
--
-- ── Por qué NULL y no un default por tipo ───────────────────────────────
--
-- La columna arranca NULL en TODOS los equipos existentes, a propósito, y
-- NULL significa "sin configurar": la validación de sobredespacho no corre
-- para esa unidad.
--
-- Rellenarla con una estimación por tipo sería PEOR que dejarla vacía: si
-- el volquete real tiene 250 L y el sistema dice 300, un despacho de 280
-- pasa como normal -- exactamente la fuga que el control existe para
-- detectar, tapada por un dato que nadie midió. Un control calibrado sobre
-- un número inventado no es un control, es una coartada.
--
-- Mismo criterio que `umbral_diferencia_pct` arrancando en 0 (migración
-- 0066): sin dato propio, no alertar todavía.
--
-- Lo que SÍ hay es una sugerencia por tipo de equipo en el formulario de
-- alta (client/src/components/equipos/EquiposTable.tsx), que precarga el
-- campo y se edita antes de guardar. Son números de catálogo general de la
-- industria, no de las máquinas de ningún cliente en particular.
--
-- ── Por qué la unidad viaja con el número ───────────────────────────────
--
-- `combustible.unidad` ya es 'gal' o 'L' POR TANQUE (migración 0057), y un
-- despacho de compra_externa no tiene tanque propio del cual heredarla. Sin
-- guardar la unidad acá, comparar 40 (gal, capacidad) contra 48 (L,
-- despacho) daría falsos positivos en masa: 48 L son 12,7 gal, ni cerca de
-- llenar un tanque de 40 gal. La conversión se hace al comparar, con las
-- dos unidades explícitas.
--
-- EJECUTAR (después de 0068):
--   psql -d mincoreerp -f migrations/0069_equipos_capacidad_tanque.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE equipos
  -- NULL = sin configurar (ver arriba). NUMERIC y no INT: hay tanques con
  -- capacidad fraccionaria en galones (ej. 78,5 gal).
  ADD COLUMN IF NOT EXISTS capacidad_tanque NUMERIC(10, 2),
  -- Sin default: la unidad no se asume, viaja junto al número o no hay
  -- número. El CHECK de abajo obliga a que vengan de a dos.
  ADD COLUMN IF NOT EXISTS capacidad_tanque_unidad VARCHAR(5);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'equipos_capacidad_tanque_check'
  ) THEN
    ALTER TABLE equipos
      ADD CONSTRAINT equipos_capacidad_tanque_check
      CHECK (
        -- O las dos NULL (sin configurar), o las dos presentes y la
        -- capacidad > 0. Un número sin unidad no se puede comparar contra
        -- nada, y una unidad sin número no dice nada -- ninguno de los dos
        -- estados a medias debe poder existir, ni siquiera por un UPDATE
        -- directo desde un script de soporte.
        (capacidad_tanque IS NULL AND capacidad_tanque_unidad IS NULL)
        OR (
          capacidad_tanque IS NOT NULL
          AND capacidad_tanque > 0
          AND capacidad_tanque_unidad IN ('gal', 'L')
        )
      );
  END IF;
END $$;

-- Sin índice: esta columna nunca se filtra ni se ordena por ella -- se lee
-- siempre junto con la fila del equipo, que ya se busca por PK o por
-- (tenant_id, placa_codigo). Agregar un índice acá sería costo de escritura
-- sin lectura que lo aproveche.
