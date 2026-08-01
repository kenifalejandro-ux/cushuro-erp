/** src/modules/iperc/iperc.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type { CrearIpercInput } from "../../server/schemas/iperc.schema";

export const IpercRepository = {

  async findAll(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion) {
    const result = await client.query(`
      SELECT i.id, i.fecha, i.turno, i.area_frente, i.equipo_id, e.placa_codigo,
        i.usuario_id, u.nombre AS usuario_nombre, i.estado,
        i.aprobado_por, ap.nombre AS aprobado_por_nombre, i.aprobado_en, i.creado_en,
        COUNT(*) OVER() AS total_count
      FROM ipercs i
      JOIN usuarios u ON u.id = i.usuario_id
      LEFT JOIN equipos e ON e.id = i.equipo_id
      LEFT JOIN usuarios ap ON ap.id = i.aprobado_por
      WHERE i.tenant_id = $1
      ORDER BY i.id DESC
      LIMIT $2 OFFSET $3
    `, [tenantId, pageSize, offset]);
    return result.rows;
  },

  async findById(client: PoolClient, tenantId: string, id: number) {
    const iperc = await client.query(
      `SELECT i.id, i.fecha, i.turno, i.area_frente, i.equipo_id, e.placa_codigo,
         i.usuario_id, u.nombre AS usuario_nombre, i.estado,
         i.aprobado_por, ap.nombre AS aprobado_por_nombre, i.aprobado_en, i.creado_en
       FROM ipercs i
       JOIN usuarios u ON u.id = i.usuario_id
       LEFT JOIN equipos e ON e.id = i.equipo_id
       LEFT JOIN usuarios ap ON ap.id = i.aprobado_por
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [id, tenantId]
    );
    if (iperc.rows.length === 0) return null;

    const items = await client.query(
      `SELECT id, etapa_actividad, peligro, riesgo, probabilidad, severidad, nivel_riesgo, medidas_control
       FROM iperc_items
       WHERE iperc_id = $1 AND tenant_id = $2
       ORDER BY id ASC`,
      [id, tenantId]
    );

    return { ...iperc.rows[0], items: items.rows };
  },

  async crear(client: PoolClient, tenantId: string, usuarioId: string, data: CrearIpercInput) {
    const iperc = await client.query(
      `INSERT INTO ipercs (tenant_id, area_frente, turno, equipo_id, usuario_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, fecha, turno, area_frente, equipo_id, usuario_id, estado, creado_en`,
      [tenantId, data.area_frente, data.turno ?? null, data.equipo_id ?? null, usuarioId]
    );
    const ipercId = iperc.rows[0].id;

    const items = [];
    for (const item of data.items) {
      const result = await client.query(
        `INSERT INTO iperc_items (tenant_id, iperc_id, etapa_actividad, peligro, riesgo, probabilidad, severidad, medidas_control)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, etapa_actividad, peligro, riesgo, probabilidad, severidad, nivel_riesgo, medidas_control`,
        [tenantId, ipercId, item.etapa_actividad, item.peligro, item.riesgo, item.probabilidad, item.severidad, item.medidas_control]
      );
      items.push(result.rows[0]);
    }

    return { ...iperc.rows[0], items };
  },

  async cambiarEstado(
    client: PoolClient,
    tenantId: string,
    id: number,
    estado: "aprobado" | "rechazado",
    aprobadoPor: string
  ) {
    const result = await client.query(
      `UPDATE ipercs SET estado = $1, aprobado_por = $2, aprobado_en = now()
       WHERE id = $3 AND tenant_id = $4
       RETURNING id, estado, aprobado_por, aprobado_en`,
      [estado, aprobadoPor, id, tenantId]
    );
    return result.rows[0] ?? null;
  },

  async eliminar(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `DELETE FROM ipercs WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return (result.rowCount ?? 0) > 0;
  },
};
