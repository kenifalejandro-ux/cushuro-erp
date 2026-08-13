-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: cuota propia por plan para repuestos_movimientos
--
-- Repuestos pasó a tener DOS recursos con cuota (ver
-- src/modules/registry.ts y el comentario largo en src/modules/types.ts):
-- 'repuestos' sigue siendo el catálogo de siempre (mismos números de
-- 0034, sin tocar), y 'repuestos_movimientos' es nuevo -- el histórico de
-- entradas/salidas de stock, que crece con el trabajo de campo, no con el
-- catálogo.
--
-- Los números salen del mismo criterio que 'combustible' en 0034 (que ya
-- cuenta un histórico de lecturas, no un catálogo): un orden de magnitud
-- mayor que 'repuestos', porque un histórico de movimientos crece con cada
-- entrada/salida real, no con cada SKU nuevo.
--
-- Sin fila para un tenant con plan asignado = cae al default del registry
-- (`porDefecto: 100_000` en la entrada `cuotasPorRuta` de Repuestos) --
-- mismo mecanismo de resolución de siempre (tenant_cuotas → plan_limites →
-- registry), no hace falta tocar nada más.
--
-- EJECUTAR (después de 0046):
--   psql -d mincoreerp -f migrations/0047_repuestos_movimientos_cuota.sql
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO plan_limites (plan_id, recurso, limite)
SELECT p.id, v.recurso, v.limite
FROM planes p
JOIN (VALUES
  ('mype',        'repuestos_movimientos', 20000::bigint),
  ('pequena',     'repuestos_movimientos', 100000),
  ('mediana',     'repuestos_movimientos', 500000),
  ('corporativo', 'repuestos_movimientos', NULL)
) AS v(codigo, recurso, limite) ON v.codigo = p.codigo
ON CONFLICT (plan_id, recurso) DO NOTHING;
