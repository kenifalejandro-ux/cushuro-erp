/** src/modules/equipos/equipos.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";

// Sin schema de validación (req.body pasa directo desde el controller) --
// documenta la forma asumida por las queries de abajo, no valida en runtime.
export type EquipoPayload = {
  placa_codigo: string;
  tipo: string;
  marca?: string;
  modelo?: string;
};

export const EquiposRepository = {
  async findAll(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion) {
    const result = await client.query(
      `
      SELECT id, placa_codigo, tipo, marca, modelo, activo, creado_en,
        COUNT(*) OVER() AS total_count
      FROM equipos
      WHERE tenant_id = $1
      ORDER BY id DESC
      LIMIT $2 OFFSET $3
    `,
      [tenantId, pageSize, offset]
    );

    return result.rows;
  },

  async create(client: PoolClient, tenantId: string, data: EquipoPayload) {
    const { placa_codigo, tipo, marca, modelo } = data;

    const result = await client.query(
      `INSERT INTO equipos (tenant_id, placa_codigo, tipo, marca, modelo)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, placa_codigo, tipo, marca, modelo, activo, creado_en`,
      [tenantId, placa_codigo, tipo, marca ?? null, modelo ?? null]
    );

    return result.rows[0];
  },

  async update(client: PoolClient, tenantId: string, id: number, data: EquipoPayload) {
    const { placa_codigo, tipo, marca, modelo } = data;

    const result = await client.query(
      `UPDATE equipos SET
        placa_codigo = $1,
        tipo = $2,
        marca = $3,
        modelo = $4
      WHERE id = $5 AND tenant_id = $6
      RETURNING id, placa_codigo, tipo, marca, modelo, activo, creado_en`,
      [placa_codigo, tipo, marca ?? null, modelo ?? null, id, tenantId]
    );

    return result.rows[0] ?? null;
  },

  async delete(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(`DELETE FROM equipos WHERE id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
    ]);
    return (result.rowCount ?? 0) > 0;
  },
};
