/**src/modules/combutible/combustible.repository.ts */

import { pool } from "../../server/config/database";

export class CombustibleRepository {

  async findAll() {
    const result = await pool.query(`
      SELECT 
        id,
        tanque_nombre,
        capacidad_total,
        nivel_actual,
        fecha_actualizacion,
        ROUND((nivel_actual / capacidad_total) * 100, 2) AS porcentaje
      FROM combustible
      ORDER BY id ASC
    `);

    return result.rows;
  }

  async findById(id: number) {
    const result = await pool.query(`
      SELECT 
        id,
        tanque_nombre,
        capacidad_total,
        nivel_actual,
        fecha_actualizacion,
        ROUND((nivel_actual / capacidad_total) * 100, 2) AS porcentaje
      FROM combustible
      WHERE id = $1
    `, [id]);

    return result.rows[0] || null;
  }

  async updateNivel(id: number, nivel_actual: number) {
    const result = await pool.query(`
      UPDATE combustible
      SET 
        nivel_actual = $1,
        fecha_actualizacion = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING 
        id,
        tanque_nombre,
        capacidad_total,
        nivel_actual,
        fecha_actualizacion,
        ROUND((nivel_actual / capacidad_total) * 100, 2) AS porcentaje
    `, [nivel_actual, id]);

    return result.rows[0];
  }
}