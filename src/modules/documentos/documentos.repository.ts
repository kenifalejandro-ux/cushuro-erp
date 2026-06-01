/**src/modules/documentos/documentos.repository.ts */

import { pool } from "../../server/config/database";

export const DocumentosRepository = {

  // ============================================================
  // 📄 GET /documentos
  // LISTAR TODOS LOS DOCUMENTOS
  // (ANTES: router.get("/documentos"))
  // ============================================================
  async findAll() {
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

    return result.rows;
  },

  // ============================================================
  // 📄 POST /documentos
  // CREAR DOCUMENTO
  // ============================================================
  async create(data: any) {
    const { nombre_documento, responsable, fecha_vencimiento } = data;

    const result = await pool.query(`
      INSERT INTO documentos 
      (nombre_documento, responsable, fecha_vencimiento)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [nombre_documento, responsable, fecha_vencimiento]);

    return result.rows[0];
  },

  // ============================================================
  // ✏️ PUT /documentos/:id
  // ACTUALIZAR DOCUMENTO
  // ============================================================
  async update(id: number, data: any) {
    const { nombre_documento, responsable, fecha_vencimiento, estado } = data;

    const result = await pool.query(`
      UPDATE documentos
      SET 
        nombre_documento = $1,
        responsable = $2,
        fecha_vencimiento = $3,
        estado = $4
      WHERE id = $5
      RETURNING *
    `, [
      nombre_documento,
      responsable,
      fecha_vencimiento,
      estado,
      id
    ]);

    return result.rows[0];
  },

  // ============================================================
  // 🗑️ DELETE /documentos/:id
  // ============================================================
  async delete(id: number) {
    await pool.query(
      "DELETE FROM documentos WHERE id = $1",
      [id]
    );
  },

    // 📦 CARGA MASIVA
  async bulkCreate(items: any[]) {
    for (const d of items) {
      await pool.query(
        `INSERT INTO documentos (nombre_documento, responsable, fecha_vencimiento)
         VALUES ($1,$2,$3)`,
        [d.nombre_documento, d.responsable, d.fecha_vencimiento]
      );
    }
  },
  
  // ============================================================
  // 📊 KPI DASHBOARD DOCUMENTOS
  // ============================================================
  async getKPIs() {
    const result = await pool.query(`
      SELECT

        -- 🔴 vencidos
        (SELECT COUNT(*) 
         FROM documentos 
         WHERE fecha_vencimiento < CURRENT_DATE) AS vencidos,

        -- 🟡 por vencer
        (SELECT COUNT(*) 
         FROM documentos 
         WHERE fecha_vencimiento BETWEEN CURRENT_DATE 
         AND CURRENT_DATE + INTERVAL '15 days') AS por_vencer,

        -- 🟢 vigentes
        (SELECT COUNT(*) 
         FROM documentos 
         WHERE fecha_vencimiento > CURRENT_DATE + INTERVAL '15 days') AS vigentes

    `);

    return result.rows[0];
  }

};