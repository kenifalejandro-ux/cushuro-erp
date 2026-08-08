/**src/modules/documentos/documentos.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";

export const DocumentosRepository = {
  // ============================================================
  // 📄 GET /documentos
  // LISTAR DOCUMENTOS (del tenant activo, paginado)
  // ============================================================
  async findAll(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion) {
    const result = await client.query(
      `
        SELECT *,
          CASE
            WHEN fecha_vencimiento < CURRENT_DATE THEN 'VENCIDO'
            WHEN fecha_vencimiento <= CURRENT_DATE + INTERVAL '15 days' THEN 'POR VENCER'
            ELSE 'VIGENTE'
          END AS estado_alerta,
          COUNT(*) OVER() AS total_count
        FROM documentos
        WHERE tenant_id = $1
        ORDER BY fecha_vencimiento ASC NULLS LAST
        LIMIT $2 OFFSET $3
      `,
      [tenantId, pageSize, offset]
    );

    return result.rows;
  },

  // ============================================================
  // 📄 POST /documentos
  // CREAR DOCUMENTO
  // ============================================================
  async create(client: PoolClient, tenantId: string, data: any) {
    const { nombre_documento, responsable, fecha_vencimiento } = data;

    const result = await client.query(
      `
      INSERT INTO documentos
      (tenant_id, nombre_documento, responsable, fecha_vencimiento)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `,
      [tenantId, nombre_documento, responsable, fecha_vencimiento]
    );

    return result.rows[0];
  },

  // ============================================================
  // ✏️ PUT /documentos/:id
  // ACTUALIZAR DOCUMENTO (solo si pertenece al tenant activo)
  // ============================================================
  async update(client: PoolClient, tenantId: string, id: number, data: any) {
    const { nombre_documento, responsable, fecha_vencimiento, estado } = data;

    const result = await client.query(
      `
      UPDATE documentos
      SET
        nombre_documento = $1,
        responsable = $2,
        fecha_vencimiento = $3,
        estado = $4
      WHERE id = $5 AND tenant_id = $6
      RETURNING *
    `,
      [nombre_documento, responsable, fecha_vencimiento, estado, id, tenantId]
    );

    return result.rows[0] ?? null;
  },

  // ============================================================
  // 🗑️ DELETE /documentos/:id
  // ============================================================
  async delete(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query("DELETE FROM documentos WHERE id = $1 AND tenant_id = $2", [
      id,
      tenantId,
    ]);
    return (result.rowCount ?? 0) > 0;
  },

  // 📦 CARGA MASIVA
  async bulkCreate(client: PoolClient, tenantId: string, items: any[]) {
    for (const d of items) {
      await client.query(
        `INSERT INTO documentos (tenant_id, nombre_documento, responsable, fecha_vencimiento)
         VALUES ($1,$2,$3,$4)`,
        [tenantId, d.nombre_documento, d.responsable, d.fecha_vencimiento]
      );
    }
  },

  // ============================================================
  // 📊 KPI DASHBOARD DOCUMENTOS
  // ============================================================
  async getKPIs(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `
      SELECT

        -- 🔴 vencidos
        (SELECT COUNT(*)
         FROM documentos
         WHERE tenant_id = $1 AND fecha_vencimiento < CURRENT_DATE) AS vencidos,

        -- 🟡 por vencer
        (SELECT COUNT(*)
         FROM documentos
         WHERE tenant_id = $1 AND fecha_vencimiento BETWEEN CURRENT_DATE
         AND CURRENT_DATE + INTERVAL '15 days') AS por_vencer,

        -- 🟢 vigentes
        (SELECT COUNT(*)
         FROM documentos
         WHERE tenant_id = $1 AND fecha_vencimiento > CURRENT_DATE + INTERVAL '15 days') AS vigentes

    `,
      [tenantId]
    );

    return result.rows[0];
  },
};
