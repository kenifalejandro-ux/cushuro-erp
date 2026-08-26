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
  // Qué instrumento mide este equipo en compra_externa (Fase B de
  // combustible) -- ver migrations/0062. undefined/null = no configurado.
  tipo_medidor?: string;
};

export const EquiposRepository = {
  async findAll(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion) {
    const result = await client.query(
      `
      SELECT id, placa_codigo, tipo, marca, modelo, tipo_medidor, activo, creado_en,
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

  async findById(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `SELECT id, placa_codigo, tipo, marca, modelo, tipo_medidor, activo, creado_en
       FROM equipos WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  },

  async create(client: PoolClient, tenantId: string, data: EquipoPayload) {
    const { placa_codigo, tipo, marca, modelo, tipo_medidor } = data;

    const result = await client.query(
      `INSERT INTO equipos (tenant_id, placa_codigo, tipo, marca, modelo, tipo_medidor)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, placa_codigo, tipo, marca, modelo, tipo_medidor, activo, creado_en`,
      [tenantId, placa_codigo, tipo, marca ?? null, modelo ?? null, tipo_medidor ?? null]
    );

    return result.rows[0];
  },

  async update(client: PoolClient, tenantId: string, id: number, data: EquipoPayload) {
    const { placa_codigo, tipo, marca, modelo, tipo_medidor } = data;

    const result = await client.query(
      `UPDATE equipos SET
        placa_codigo = $1,
        tipo = $2,
        marca = $3,
        modelo = $4,
        tipo_medidor = $5
      WHERE id = $6 AND tenant_id = $7
      RETURNING id, placa_codigo, tipo, marca, modelo, tipo_medidor, activo, creado_en`,
      [placa_codigo, tipo, marca ?? null, modelo ?? null, tipo_medidor ?? null, id, tenantId]
    );

    return result.rows[0] ?? null;
  },

  /** Lectura mínima para el chequeo por-equipo de un despacho compra_externa
   *  (ver combustible.service.ts) -- no trae las demás columnas porque no
   *  hacen falta ahí. */
  async findTipoMedidor(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query<{ id: number; tipo_medidor: string | null }>(
      `SELECT id, tipo_medidor FROM equipos WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
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
