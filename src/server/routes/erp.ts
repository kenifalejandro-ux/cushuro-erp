/** src/server/routes/erp.ts */
import { Router, type Request, type Response } from "express";
import { pool } from "../config/database";

export function createErpRouter() {
  const router = Router();

  // ============================================================
  // 1. DASHBOARD - ESTADÍSTICAS GENERALES + CHARTS
  // ============================================================
  router.get("/dashboard", async (_req: Request, res: Response) => {
    try {
      // KPIs principales
const result = await pool.query(`
  SELECT
    -- Operativos
    (SELECT COUNT(*) FROM repuestos)::int AS total_repuestos,
    (SELECT COUNT(*) FROM repuestos WHERE stock <= stock_minimo)::int AS stock_bajo,
    COALESCE((SELECT ROUND(SUM(stock * precio), 2) FROM repuestos),0) AS valor_inventario,

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

    -- Combustible
    COALESCE((
      SELECT ROUND((nivel_actual / capacidad_total) * 100, 2)
      FROM combustible LIMIT 1
    ),0) AS combustible_porcentaje,

    -- Documentos
    (SELECT COUNT(*) FROM documentos WHERE fecha_vencimiento < CURRENT_DATE)::int AS docs_vencidos,
    (SELECT COUNT(*) FROM documentos 
     WHERE fecha_vencimiento BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '15 days'
    )::int AS docs_por_vencer
`);

      // Gráfico 1: Inventario por categoría
      const inventarioCategoria = await pool.query(`
        SELECT categoria, COUNT(*)::int AS total
        FROM repuestos
        GROUP BY categoria
        ORDER BY total DESC
      `);

      // Gráfico 2: Valor por categoría
      const valorCategoria = await pool.query(`
        SELECT categoria,
        ROUND(SUM(stock * precio),2)::numeric AS valor_total
        FROM repuestos
        GROUP BY categoria
        ORDER BY valor_total DESC
      `);

      // Gráfico 3: Estado documentos
      const documentosEstado = await pool.query(`
  SELECT estado, COUNT(*)::int AS total
  FROM (
    SELECT
      CASE 
        WHEN fecha_vencimiento < CURRENT_DATE THEN 'VENCIDO'
        WHEN fecha_vencimiento <= CURRENT_DATE + INTERVAL '15 days' THEN 'POR VENCER'
        ELSE 'VIGENTE'
      END AS estado
    FROM documentos
  ) t
  GROUP BY estado
`);

      res.json({
        ...result.rows[0],
        inventario_categoria: inventarioCategoria.rows,
        valor_categoria: valorCategoria.rows,
        documentos_estado: documentosEstado.rows,
        
      });

    } catch (error) {
      console.error("Error en /dashboard:", error);
      res.status(500).json({ error: "Error al obtener datos del dashboard" });
    }
  });

  // ============================================================
  // 2. REPUESTOS - LISTAR
  // ============================================================
  router.get("/repuestos", async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(`
        SELECT 
          id, 
          codigo, 
          nombre, 
          categoria, 
          stock, 
          stock_minimo, 
          stock_maximo, 
          precio,
          TO_CHAR(fecha_creacion, 'DD/MM/YYYY') as fecha
        FROM repuestos 
        ORDER BY codigo ASC
      `);
      res.json(result.rows);
    } catch (error) {
      console.error("Error al obtener repuestos:", error);
      res.status(500).json({ error: "Error en el servidor" });
    }
  });

  // ============================================================
  // 3. REPUESTOS - REGISTRO MANUAL
  // ============================================================
  router.post("/repuestos/manual", async (req: Request, res: Response) => {
    const { codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio } = req.body;

    try {
      await pool.query(
        `INSERT INTO repuestos 
         (codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [codigo, nombre, categoria || "General", stock, stock_minimo, stock_maximo, precio]
      );

      res.json({ message: "Repuesto registrado correctamente" });

    } catch (error) {
      console.error("Error en registro manual:", error);
      res.status(500).json({ error: "No se pudo registrar el repuesto" });
    }
  });

  // ============================================================
  // 4. REPUESTOS - CARGA MASIVA
  // ============================================================
  router.post("/repuestos/bulk", async (req: Request, res: Response) => {
    const repuestos = req.body;

    if (!Array.isArray(repuestos)) {
      return res.status(400).json({ error: "Formato de datos inválido" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (const r of repuestos) {
        await client.query(
          `INSERT INTO repuestos
           (codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (codigo) DO UPDATE SET
           stock = repuestos.stock + EXCLUDED.stock,
           precio = EXCLUDED.precio`,
          [
            r.codigo,
            r.nombre,
            r.categoria || "General",
            r.stock || 0,
            r.stock_minimo || 5,
            r.stock_maximo || 10,
            r.precio || 0
          ]
        );
      }

      await client.query("COMMIT");
      res.json({ message: `${repuestos.length} repuestos procesados correctamente` });

    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Error en carga masiva:", error);
      res.status(500).json({ error: "Fallo en la carga masiva" });
    } finally {
      client.release();
    }
  });

  // ============================================================
  // 5. REPUESTOS - EDITAR
  // ============================================================
  router.put("/repuestos/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio } = req.body;

    try {
      const result = await pool.query(
        `UPDATE repuestos 
         SET codigo = $1,
             nombre = $2,
             categoria = $3,
             stock = $4,
             stock_minimo = $5,
             stock_maximo = $6,
             precio = $7
         WHERE id = $8`,
        [codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio, id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "No encontrado" });
      }

      res.json({ message: "Actualizado con éxito" });

    } catch (error) {
      console.error("Error al editar:", error);
      res.status(500).json({ error: "Fallo al actualizar" });
    }
  });

  // ============================================================
  // 6. REPUESTOS - ELIMINAR
  // ============================================================
  router.delete("/repuestos/:id", async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
      const result = await pool.query(
        "DELETE FROM repuestos WHERE id = $1",
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "No encontrado" });
      }

      res.json({ message: "Eliminado correctamente" });

    } catch (error) {
      console.error("Error al eliminar:", error);
      res.status(500).json({ error: "Error al eliminar" });
    }
  });

  // ============================================================
  // 7. COMBUSTIBLE
  // ============================================================
  router.get("/combustible", async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(`
        SELECT *,
          ROUND((nivel_actual / capacidad_total) * 100, 2) AS porcentaje
        FROM combustible 
        ORDER BY tanque_nombre
      `);

      res.json(result.rows);

    } catch (error) {
      console.error("Error en /combustible:", error);
      res.status(500).json({ error: "Error al obtener combustible" });
    }
  });

  // ============================================================
  // 8. DOCUMENTOS
  // ============================================================
  router.get("/documentos", async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(`
        SELECT *,
          CASE 
            WHEN fecha_vencimiento < CURRENT_DATE THEN 'VENCIDO'
            WHEN fecha_vencimiento <= CURRENT_DATE + INTERVAL '15 days' THEN 'POR VENCER'
            ELSE 'VIGENTE'
          END AS estado_alerta
        FROM documentos 
        ORDER BY fecha_vencimiento ASC NULLS LAST
      `);

      res.json(result.rows);

    } catch (error) {
      console.error("Error al obtener documentos:", error);
      res.status(500).json({ error: "Error al obtener documentos" });
    }
  });

  return router;
}