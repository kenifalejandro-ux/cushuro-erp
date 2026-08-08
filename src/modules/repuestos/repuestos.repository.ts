/** src/modules/repuestos/repuestos.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";

export const RepuestosRepository = {
  // =========================================================
  // 📥 LISTAR REPUESTOS (del tenant activo, paginado)
  // =========================================================
  async findAll(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion) {
    const result = await client.query(
      `
      SELECT
        id,
        codigo,
        nombre,
        categoria,
        stock,
        stock_minimo,
        stock_maximo,
        precio,
        fecha_creacion AS fecha,
        COUNT(*) OVER() AS total_count
      FROM repuestos
      WHERE tenant_id = $1
      ORDER BY id DESC
      LIMIT $2 OFFSET $3
    `,
      [tenantId, pageSize, offset]
    );

    return result.rows;
  },

  // =========================================================
  // ➕ CREAR REPUESTO
  // =========================================================
  async create(client: PoolClient, tenantId: string, data: any) {
    const { codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio } = data;

    const result = await client.query(
      `
      INSERT INTO repuestos (
        tenant_id,
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
        $1,$2,$3,$4,$5,$6,$7,$8,NOW()
      )
      RETURNING *
      `,
      [tenantId, codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio]
    );

    return result.rows[0];
  },

  // =========================================================
  // ✏️ ACTUALIZAR REPUESTO (solo si pertenece al tenant activo)
  // =========================================================
  async update(client: PoolClient, tenantId: string, id: number, data: any) {
    const { codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio } = data;

    const result = await client.query(
      `
      UPDATE repuestos SET
        codigo = $1,
        nombre = $2,
        categoria = $3,
        stock = $4,
        stock_minimo = $5,
        stock_maximo = $6,
        precio = $7
      WHERE id = $8 AND tenant_id = $9
      RETURNING *
      `,
      [codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio, id, tenantId]
    );

    return result.rows[0] ?? null;
  },

  // =========================================================
  // 🗑 ELIMINAR REPUESTO (solo si pertenece al tenant activo)
  // =========================================================
  async delete(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(`DELETE FROM repuestos WHERE id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
    ]);
    return (result.rowCount ?? 0) > 0;
  },

  // =========================================================
  // 📦 INSERCIÓN MASIVA
  // =========================================================
  async createBulk(client: PoolClient, tenantId: string, rows: any[]) {
    const results = [];
    for (const data of rows) {
      const { codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio } = data;
      const result = await client.query(
        `INSERT INTO repuestos (tenant_id, codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio, fecha_creacion)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (tenant_id, codigo) DO UPDATE SET
           nombre = EXCLUDED.nombre,
           categoria = EXCLUDED.categoria,
           stock = EXCLUDED.stock,
           stock_minimo = EXCLUDED.stock_minimo,
           stock_maximo = EXCLUDED.stock_maximo,
           precio = EXCLUDED.precio
         RETURNING *`,
        [
          tenantId,
          codigo,
          nombre,
          categoria ?? "General",
          stock ?? 0,
          stock_minimo ?? 5,
          stock_maximo ?? 30,
          precio ?? 0,
        ]
      );
      results.push(result.rows[0]);
    }
    return results;
  },

  // =========================================================
  // 📊 KPIs DASHBOARD
  // =========================================================
  async getDashboardKPIs(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `
    SELECT
      (SELECT COUNT(*) FROM repuestos WHERE tenant_id = $1) AS total_repuestos,

      -- 🔴 Bajo mínimo
      (SELECT COUNT(*)
       FROM repuestos
       WHERE tenant_id = $1 AND stock <= stock_minimo) AS stock_bajo,

      -- 🟣 Sobre máximo
      (SELECT COUNT(*)
       FROM repuestos
       WHERE tenant_id = $1 AND stock >= stock_maximo) AS stock_sobre,

      -- 🟢 En rango saludable
      (SELECT COUNT(*)
       FROM repuestos
       WHERE tenant_id = $1 AND stock > stock_minimo
       AND stock < stock_maximo) AS stock_saludable,

      -- 💰 Valor inventario
      (SELECT COALESCE(ROUND(SUM(stock * precio),2),0)
       FROM repuestos WHERE tenant_id = $1) AS valor_inventario
  `,
      [tenantId]
    );

    return result.rows[0];
  },
};
