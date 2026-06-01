/** src/server/routes/dashboard.ts */

import { Router } from "express";
import { pool } from "../config/database";

export function createDashboardRouter() {
  const router = Router();

  router.get("/dashboard", async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          -- =========================
          -- 📦 KPIs INVENTARIO
          -- =========================

          (SELECT COUNT(*) FROM repuestos)::int AS total_repuestos,

          -- 🔴 Bajo mínimo
          (SELECT COUNT(*) 
           FROM repuestos 
           WHERE stock <= stock_minimo
          )::int AS stock_bajo,

          -- 🟣 Sobre máximo
          (SELECT COUNT(*) 
           FROM repuestos 
           WHERE stock >= stock_maximo
          )::int AS sobre_stock,

          -- 🟢 En rango saludable
          (SELECT COUNT(*) 
           FROM repuestos
           WHERE stock > stock_minimo
           AND stock < stock_maximo
          )::int AS stock_saludable,

          -- 💰 Valor total inventario
          COALESCE((
            SELECT ROUND(SUM(stock * precio), 2)
            FROM repuestos
          ),0) AS valor_inventario,

          -- 💸 Valor inventario bajo mínimo
          COALESCE((
            SELECT ROUND(SUM(stock * precio), 2)
            FROM repuestos
            WHERE stock <= stock_minimo
          ),0) AS valor_stock_bajo,

          -- 💸 Valor sobre stock
          COALESCE((
            SELECT ROUND(SUM(stock * precio), 2)
            FROM repuestos
            WHERE stock >= stock_maximo
          ),0) AS valor_sobre_stock,

          -- 📊 % productos en riesgo
          COALESCE((
            SELECT ROUND(
              (COUNT(*) FILTER (WHERE stock <= stock_minimo) * 100.0)
              / NULLIF(COUNT(*), 0),
            2)
            FROM repuestos
          ),0) AS porcentaje_riesgo,

          -- =========================
          -- ⛽ Combustible
          -- =========================
          COALESCE((
            SELECT ROUND((nivel_actual / capacidad_total) * 100, 2)
            FROM combustible
            LIMIT 1
          ),0) AS combustible_porcentaje,

          -- =========================
          -- 📄 Documentos
          -- =========================

          (SELECT COUNT(*) 
           FROM documentos 
           WHERE fecha_vencimiento < CURRENT_DATE
          )::int AS docs_vencidos,

          (SELECT COUNT(*) 
           FROM documentos 
           WHERE fecha_vencimiento 
           BETWEEN CURRENT_DATE 
           AND CURRENT_DATE + INTERVAL '15 days'
          )::int AS docs_por_vencer

      `);

      res.json(result.rows[0]);

    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Error en dashboard" });
    }
  });

  return router;
}