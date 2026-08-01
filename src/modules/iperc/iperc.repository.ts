/** src/modules/iperc/iperc.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type { CrearIpercInput, CrearLineaBaseInput } from "../../server/schemas/iperc.schema";

export const IpercRepository = {

  async findAll(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion, tipo?: string) {
    const params: any[] = [tenantId];
    let filtroTipo = "";
    if (tipo) {
      params.push(tipo);
      filtroTipo = ` AND i.tipo = $${params.length}`;
    }
    params.push(pageSize, offset);

    const result = await client.query(`
      SELECT i.id, i.tipo, i.fecha, i.turno, i.area_frente, i.equipo_id, e.placa_codigo,
        i.linea_base_id, i.tarea_especifica,
        i.usuario_id, u.nombre AS usuario_nombre, i.estado,
        i.aprobado_por, ap.nombre AS aprobado_por_nombre, i.aprobado_en, i.creado_en,
        COUNT(*) OVER() AS total_count
      FROM ipercs i
      JOIN usuarios u ON u.id = i.usuario_id
      LEFT JOIN equipos e ON e.id = i.equipo_id
      LEFT JOIN usuarios ap ON ap.id = i.aprobado_por
      WHERE i.tenant_id = $1${filtroTipo}
      ORDER BY i.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    return result.rows;
  },

  async findById(client: PoolClient, tenantId: string, id: number) {
    const iperc = await client.query(
      `SELECT i.id, i.tipo, i.fecha, i.turno, i.area_frente, i.equipo_id, e.placa_codigo,
         i.linea_base_id, i.tarea_especifica,
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
      `SELECT id, linea_base_item_id, etapa_actividad, peligro, riesgo, probabilidad, severidad, nivel_riesgo, medidas_control
       FROM iperc_items
       WHERE iperc_id = $1 AND tenant_id = $2
       ORDER BY id ASC`,
      [id, tenantId]
    );

    return { ...iperc.rows[0], items: items.rows };
  },

  async crear(client: PoolClient, tenantId: string, usuarioId: string, data: CrearIpercInput) {
    const iperc = await client.query(
      `INSERT INTO ipercs (tenant_id, tipo, area_frente, turno, equipo_id, linea_base_id, tarea_especifica, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, tipo, fecha, turno, area_frente, equipo_id, linea_base_id, tarea_especifica, usuario_id, estado, creado_en`,
      [
        tenantId,
        data.tipo,
        data.area_frente,
        data.turno ?? null,
        data.equipo_id ?? null,
        data.linea_base_id ?? null,
        data.tarea_especifica ?? null,
        usuarioId,
      ]
    );
    const ipercId = iperc.rows[0].id;

    const items = [];
    for (const item of data.items) {
      let { etapa_actividad, peligro, riesgo, probabilidad, severidad, medidas_control } = item;

      // Si el ítem referencia un ítem de la línea base, se copian sus
      // campos desde el catálogo (mismo tenant) — nunca se confía en lo
      // que mande el cliente para esos campos, para que el registro
      // quede consistente con lo ya evaluado y aprobado.
      if (item.linea_base_item_id !== undefined) {
        const base = await client.query(
          `SELECT etapa_actividad, peligro, riesgo, probabilidad, severidad, medidas_control
           FROM iperc_linea_base_items WHERE id = $1 AND tenant_id = $2`,
          [item.linea_base_item_id, tenantId]
        );
        if (base.rows.length === 0) {
          throw new Error(`linea_base_item_id ${item.linea_base_item_id} no existe en este tenant`);
        }
        ({ etapa_actividad, peligro, riesgo, probabilidad, severidad, medidas_control } = base.rows[0]);
      }

      const result = await client.query(
        `INSERT INTO iperc_items (tenant_id, iperc_id, linea_base_item_id, etapa_actividad, peligro, riesgo, probabilidad, severidad, medidas_control)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, linea_base_item_id, etapa_actividad, peligro, riesgo, probabilidad, severidad, nivel_riesgo, medidas_control`,
        [tenantId, ipercId, item.linea_base_item_id ?? null, etapa_actividad, peligro, riesgo, probabilidad, severidad, medidas_control]
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

  // ── Línea Base ───────────────────────────────────────────────────────
  async findLineasBase(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion) {
    const result = await client.query(`
      SELECT id, proceso_actividad, area_frente, estado, aprobado_por, aprobado_en, creado_por, creado_en,
        COUNT(*) OVER() AS total_count
      FROM iperc_lineas_base
      WHERE tenant_id = $1
      ORDER BY id DESC
      LIMIT $2 OFFSET $3
    `, [tenantId, pageSize, offset]);
    return result.rows;
  },

  async findLineaBaseConItems(client: PoolClient, tenantId: string, id: number) {
    const lineaBase = await client.query(
      `SELECT id, proceso_actividad, area_frente, estado, aprobado_por, aprobado_en, creado_por, creado_en
       FROM iperc_lineas_base WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (lineaBase.rows.length === 0) return null;

    const items = await client.query(
      `SELECT id, etapa_actividad, peligro, riesgo, probabilidad, severidad, nivel_riesgo, medidas_control
       FROM iperc_linea_base_items
       WHERE linea_base_id = $1 AND tenant_id = $2
       ORDER BY id ASC`,
      [id, tenantId]
    );

    return { ...lineaBase.rows[0], items: items.rows };
  },

  async crearLineaBase(client: PoolClient, tenantId: string, creadoPor: string, data: CrearLineaBaseInput) {
    const lineaBase = await client.query(
      `INSERT INTO iperc_lineas_base (tenant_id, proceso_actividad, area_frente, creado_por)
       VALUES ($1, $2, $3, $4)
       RETURNING id, proceso_actividad, area_frente, estado, creado_por, creado_en`,
      [tenantId, data.proceso_actividad, data.area_frente ?? null, creadoPor]
    );
    const lineaBaseId = lineaBase.rows[0].id;

    const items = [];
    for (const item of data.items) {
      const result = await client.query(
        `INSERT INTO iperc_linea_base_items (tenant_id, linea_base_id, etapa_actividad, peligro, riesgo, probabilidad, severidad, medidas_control)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, etapa_actividad, peligro, riesgo, probabilidad, severidad, nivel_riesgo, medidas_control`,
        [tenantId, lineaBaseId, item.etapa_actividad, item.peligro, item.riesgo, item.probabilidad, item.severidad, item.medidas_control]
      );
      items.push(result.rows[0]);
    }

    return { ...lineaBase.rows[0], items };
  },

  async cambiarEstadoLineaBase(
    client: PoolClient,
    tenantId: string,
    id: number,
    estado: "aprobado" | "rechazado",
    aprobadoPor: string
  ) {
    const result = await client.query(
      `UPDATE iperc_lineas_base SET estado = $1, aprobado_por = $2, aprobado_en = now()
       WHERE id = $3 AND tenant_id = $4
       RETURNING id, estado, aprobado_por, aprobado_en`,
      [estado, aprobadoPor, id, tenantId]
    );
    return result.rows[0] ?? null;
  },

  async eliminarLineaBase(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `DELETE FROM iperc_lineas_base WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return (result.rowCount ?? 0) > 0;
  },
};
