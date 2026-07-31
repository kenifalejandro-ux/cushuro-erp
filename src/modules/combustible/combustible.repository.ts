/**src/modules/combutible/combustible.repository.ts */

import type { PoolClient } from "pg";

export class CombustibleRepository {

  async findAll(client: PoolClient, tenantId: string) {
    const result = await client.query(`
      SELECT
        id,
        tanque_nombre,
        capacidad_total,
        nivel_actual,
        fecha_actualizacion,
        ROUND((nivel_actual / capacidad_total) * 100, 2) AS porcentaje
      FROM combustible
      WHERE tenant_id = $1
      ORDER BY id ASC
    `, [tenantId]);

    return result.rows;
  }

  async findById(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(`
      SELECT
        id,
        tanque_nombre,
        capacidad_total,
        nivel_actual,
        fecha_actualizacion,
        ROUND((nivel_actual / capacidad_total) * 100, 2) AS porcentaje
      FROM combustible
      WHERE id = $1 AND tenant_id = $2
    `, [id, tenantId]);

    return result.rows[0] || null;
  }

  async updateNivel(client: PoolClient, tenantId: string, id: number, nivel_actual: number) {
    const result = await client.query(`
      UPDATE combustible
      SET
        nivel_actual = $1,
        fecha_actualizacion = CURRENT_TIMESTAMP
      WHERE id = $2 AND tenant_id = $3
      RETURNING
        id,
        tanque_nombre,
        capacidad_total,
        nivel_actual,
        fecha_actualizacion,
        ROUND((nivel_actual / capacidad_total) * 100, 2) AS porcentaje
    `, [nivel_actual, id, tenantId]);

    return result.rows[0] ?? null;
  }
}
