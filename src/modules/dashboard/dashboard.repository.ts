/** src/modules/dashboard/dashboard.repository.ts */

import type { PoolClient } from "pg";

export const DashboardRepository = {

  // ============================================================
  // 📊 KPI GENERAL (CARDS)
  // ============================================================
  async getKPIs(client: PoolClient, tenantId: string) {
    const result = await client.query(`
      SELECT

        --   // 📊 KPI 🧩 REPUESTOS OPERATIVOS
        (SELECT COUNT(*) FROM repuestos WHERE tenant_id = $1) AS total_repuestos,
        (SELECT COUNT(*) FROM repuestos WHERE tenant_id = $1 AND stock <= stock_minimo) AS stock_bajo,
        (SELECT ROUND(SUM(stock * precio),2) FROM repuestos WHERE tenant_id = $1) AS valor_inventario,

        --   // 📊 KPI 🧩 REPUESTOS ESTRATÉGICOS

        -- Estratégico 1: % Inventario en riesgo
    COALESCE((
      SELECT ROUND(
        (COUNT(*) FILTER (WHERE stock <= stock_minimo) * 100.0)
        / NULLIF(COUNT(*), 0),
      2)
      FROM repuestos
      WHERE tenant_id = $1
    ),0) AS porcentaje_riesgo,

    -- Estratégico 2: Sobre stock
    (SELECT COUNT(*) FROM repuestos WHERE tenant_id = $1 AND stock >= stock_maximo)::int AS sobre_stock,

    -- Estratégico 3: Valor inventario en riesgo
    COALESCE((
      SELECT ROUND(SUM(stock * precio), 2)
      FROM repuestos
      WHERE tenant_id = $1 AND stock <= stock_minimo
    ),0) AS valor_stock_bajo,


        -- ⛽ COMBUSTIBLE
        (SELECT ROUND((nivel_actual / capacidad_total) * 100, 2)
         FROM combustible WHERE tenant_id = $1 LIMIT 1) AS combustible_porcentaje,

        -- 📄 DOCUMENTOS
        (SELECT COUNT(*) FROM documentos
         WHERE tenant_id = $1 AND fecha_vencimiento < CURRENT_DATE) AS docs_vencidos,

        (SELECT COUNT(*) FROM documentos
         WHERE tenant_id = $1 AND fecha_vencimiento
         BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '15 days') AS docs_por_vencer

    `, [tenantId]);

    return result.rows[0];
  },

  // ============================================================
  // 📊 CHART 1 - REPUESTOS POR CATEGORÍA (Bar Chart)
  // ============================================================
  async repuestosPorCategoria(client: PoolClient, tenantId: string) {
    const result = await client.query(`
SELECT
categoria,
COUNT(*) AS total
FROM repuestos
WHERE tenant_id = $1
GROUP BY categoria
ORDER BY total DESC;
    `, [tenantId]);

    return result.rows;
  },

  // ============================================================
  // 📊 CHART 2 - VALOR INVENTARIO POR CATEGORÍA
  // ============================================================
  async valorPorCategoria(client: PoolClient, tenantId: string) {
    const result = await client.query(`
      SELECT
        categoria,
        ROUND(SUM(stock * precio),2) AS valor_total
      FROM repuestos
      WHERE tenant_id = $1
      GROUP BY categoria
      ORDER BY valor_total DESC
    `, [tenantId]);

    return result.rows;
  },

  // 📊 CHART 3 - DOCUMENTOS ((Pie Chart))
  // ============================================================
  async estadoDocumentos(client: PoolClient, tenantId: string) {
    // Usamos una subconsulta para definir el alias "estado" primero
    // y luego agrupamos por ese alias en la consulta exterior.
    const result = await client.query(`
      SELECT
        estado,
                COUNT(*)::INT AS total  -- 🔥 Forzamos a que sea un entero

      FROM (
        SELECT
          CASE
            WHEN fecha_vencimiento < CURRENT_DATE THEN 'VENCIDO'
            WHEN fecha_vencimiento <= CURRENT_DATE + INTERVAL '15 days' THEN 'POR VENCER'
            ELSE 'VIGENTE'
          END AS estado
        FROM documentos
        WHERE tenant_id = $1
      ) AS subconsulta
      GROUP BY estado
      ORDER BY total DESC
    `, [tenantId]);

    return result.rows;
  },

  // 📊  Chart 4 — Nivel de stock vs mínimo (Comparativo)
  // ============================================================
  async nivelstock(client: PoolClient, tenantId: string) {
    const result = await client.query(`
      SELECT
nombre,
stock,
stock_minimo
FROM repuestos
WHERE tenant_id = $1
ORDER BY stock ASC
LIMIT 10
`, [tenantId]);
    return result.rows;
  }

};
