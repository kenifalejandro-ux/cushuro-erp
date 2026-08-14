-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: cuota por plan para ordenes_trabajo
--
-- Mismo mecanismo que 0047 (repuestos_movimientos): sin fila para un
-- tenant con plan asignado, el límite cae al default del registry
-- (`porDefecto: 50_000` en la entrada `ordenes_trabajo` de
-- src/modules/registry.ts) -- esto reemplaza ese fallback con números
-- derivados del tamaño real de cada plan.
--
-- Los números NO siguen el mismo criterio que checklists/combustible (que
-- escalan ~1 por equipo por TURNO, altísima frecuencia). Una OT es un
-- evento de mantenimiento (correctivo + preventivo), no una rutina diaria
-- -- estimado en ~2 OT por equipo por mes:
--
--   mype (20 equipos):    20 × 2/mes × 12 ≈ 480/año  → 2.000  (~4 años de margen)
--   pequena (100 equipos): 100 × 2 × 12 ≈ 2.400/año  → 10.000
--   mediana (500 equipos): 500 × 2 × 12 ≈ 12.000/año → 50.000
--
-- EJECUTAR (después de 0051):
--   psql -d mincoreerp -f migrations/0052_ordenes_trabajo_plan_limites.sql
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO plan_limites (plan_id, recurso, limite)
SELECT p.id, v.recurso, v.limite
FROM planes p
JOIN (VALUES
  ('mype',        'ordenes_trabajo', 2000::bigint),
  ('pequena',     'ordenes_trabajo', 10000),
  ('mediana',     'ordenes_trabajo', 50000),
  ('corporativo', 'ordenes_trabajo', NULL)
) AS v(codigo, recurso, limite) ON v.codigo = p.codigo
ON CONFLICT (plan_id, recurso) DO NOTHING;
