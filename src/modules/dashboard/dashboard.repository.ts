/** src/modules/dashboard/dashboard.repository.ts */

import { pool } from "../../server/config/database";

export const DashboardRepository = {

  // ============================================================
  // 📊 KPI GENERAL (CARDS)
  // ============================================================
  async getKPIs() {
    const result = await pool.query(`
      SELECT
        
        --   // 📊 KPI 🧩 REPUESTOS OPERATIVOS
        (SELECT COUNT(*) FROM repuestos) AS total_repuestos,
        (SELECT COUNT(*) FROM repuestos WHERE stock <= stock_minimo) AS stock_bajo,
        (SELECT ROUND(SUM(stock * precio),2) FROM repuestos) AS valor_inventario,

        --   // 📊 KPI 🧩 REPUESTOS ESTRATÉGICOS

        -- Estratégico 1: % Inventario en riesgo
    COALESCE((
      SELECT ROUND(
        (COUNT(*) FILTER (WHERE stock <= stock_minimo) * 100.0) 
        / NULLIF(COUNT(*), 0),
      2)
      FROM repuestos
    ),0) AS porcentaje_riesgo,

    -- Estratégico 2: Sobre stock
    (SELECT COUNT(*) FROM repuestos WHERE stock >= stock_maximo)::int AS sobre_stock,

    -- Estratégico 3: Valor inventario en riesgo
    COALESCE((
      SELECT ROUND(SUM(stock * precio), 2)
      FROM repuestos
      WHERE stock <= stock_minimo
    ),0) AS valor_stock_bajo,


        -- ⛽ COMBUSTIBLE
        (SELECT ROUND((nivel_actual / capacidad_total) * 100, 2) 
         FROM combustible LIMIT 1) AS combustible_porcentaje,

        -- 📄 DOCUMENTOS
        (SELECT COUNT(*) FROM documentos 
         WHERE fecha_vencimiento < CURRENT_DATE) AS docs_vencidos,

        (SELECT COUNT(*) FROM documentos 
         WHERE fecha_vencimiento 
         BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '15 days') AS docs_por_vencer

    `);

    return result.rows[0];
  },

  // ============================================================
  // 📊 CHART 1 - REPUESTOS POR CATEGORÍA (Bar Chart)
  // ============================================================
  async repuestosPorCategoria() {
    const result = await pool.query(`
SELECT 
categoria,
COUNT(*) AS total
FROM repuestos
GROUP BY categoria
ORDER BY total DESC;
    `);

    return result.rows;
  },

  // ============================================================
  // 📊 CHART 2 - VALOR INVENTARIO POR CATEGORÍA 
  // ============================================================
  async valorPorCategoria() {
    const result = await pool.query(`
      SELECT 
        categoria,
        ROUND(SUM(stock * precio),2) AS valor_total
      FROM repuestos
      GROUP BY categoria
      ORDER BY valor_total DESC
    `);

    return result.rows;
  },

  // 📊 CHART 3 - DOCUMENTOS ((Pie Chart))
  // ============================================================
  async estadoDocumentos() {
    // Usamos una subconsulta para definir el alias "estado" primero
    // y luego agrupamos por ese alias en la consulta exterior.
    const result = await pool.query(`
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
      ) AS subconsulta
      GROUP BY estado
      ORDER BY total DESC
    `);

    return result.rows;
  },
  
  // 📊  Chart 4 — Nivel de stock vs mínimo (Comparativo)
  // ============================================================
  async nivelstock() {
    const result = await pool.query(`
      SELECT 
nombre,
stock,
stock_minimo
FROM repuestos
ORDER BY stock ASC
LIMIT 10
`);
    return result.rows;
  }

};