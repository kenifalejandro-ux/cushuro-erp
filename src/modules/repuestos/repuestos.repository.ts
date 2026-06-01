/** src/modules/repuestos/repuestos.repository.ts */

import { pool } from "../../server/config/database";

export const RepuestosRepository = {

  // =========================================================
  // 📥 LISTAR TODOS LOS REPUESTOS
  // =========================================================
  async findAll() {
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
        fecha_creacion AS fecha
      FROM repuestos
      ORDER BY id DESC
    `);

    return result.rows;
  },

  // =========================================================
  // ➕ CREAR REPUESTO
  // =========================================================
  async create(data: any) {
    const {
      codigo,
      nombre,
      categoria,
      stock,
      stock_minimo,
      stock_maximo,
      precio
    } = data;

    const result = await pool.query(
      `
      INSERT INTO repuestos (
        codigo,
        nombre,
        categoria,
        stock,
        stock_minimo,
        stock_maximo,
        precio,
        fecha_creacion
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,NOW()
      )
      RETURNING *
      `,
      [
        codigo,
        nombre,
        categoria,
        stock,
        stock_minimo,
        stock_maximo,
        precio
      ]
    );

    return result.rows[0];
  },

  // =========================================================
  // ✏️ ACTUALIZAR REPUESTO
  // =========================================================
  async update(id: number, data: any) {
    const {
      codigo,
      nombre,
      categoria,
      stock,
      stock_minimo,
      stock_maximo,
      precio
    } = data;

    const result = await pool.query(
      `
      UPDATE repuestos SET
        codigo = $1,
        nombre = $2,
        categoria = $3,
        stock = $4,
        stock_minimo = $5,
        stock_maximo = $6,
        precio = $7
      WHERE id = $8
      RETURNING *
      `,
      [
        codigo,
        nombre,
        categoria,
        stock,
        stock_minimo,
        stock_maximo,
        precio,
        id
      ]
    );

    return result.rows[0];
  },

  // =========================================================
  // 🗑 ELIMINAR REPUESTO
  // =========================================================
  async delete(id: number) {
    await pool.query(
      `DELETE FROM repuestos WHERE id = $1`,
      [id]
    );
  },

  // =========================================================
  // 📦 INSERCIÓN MASIVA
  // =========================================================
  async createBulk(rows: any[]) {
    const results = [];
    for (const data of rows) {
      const { codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio } = data;
      const result = await pool.query(
        `INSERT INTO repuestos (codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio, fecha_creacion)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (codigo) DO UPDATE SET
           nombre = EXCLUDED.nombre,
           categoria = EXCLUDED.categoria,
           stock = EXCLUDED.stock,
           stock_minimo = EXCLUDED.stock_minimo,
           stock_maximo = EXCLUDED.stock_maximo,
           precio = EXCLUDED.precio
         RETURNING *`,
        [codigo, nombre, categoria ?? 'General', stock ?? 0, stock_minimo ?? 5, stock_maximo ?? 30, precio ?? 0]
      );
      results.push(result.rows[0]);
    }
    return results;
  },

 // =========================================================
// 📊 KPIs DASHBOARD
// =========================================================
async getDashboardKPIs() {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM repuestos) AS total_repuestos,

      -- 🔴 Bajo mínimo
      (SELECT COUNT(*) 
       FROM repuestos 
       WHERE stock <= stock_minimo) AS stock_bajo,

      -- 🟣 Sobre máximo
      (SELECT COUNT(*) 
       FROM repuestos 
       WHERE stock >= stock_maximo) AS stock_sobre,

      -- 🟢 En rango saludable
      (SELECT COUNT(*) 
       FROM repuestos 
       WHERE stock > stock_minimo 
       AND stock < stock_maximo) AS stock_saludable,

      -- 💰 Valor inventario
      (SELECT COALESCE(ROUND(SUM(stock * precio),2),0) 
       FROM repuestos) AS valor_inventario
  `);

  return result.rows[0];
}
};