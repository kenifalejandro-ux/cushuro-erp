/**src/modules/combutible/combustible.repository.ts */

import type { PoolClient } from "pg";

export class CombustibleRepository {
  async findAll(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `
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
    `,
      [tenantId]
    );

    return result.rows;
  }

  async findById(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `
      SELECT
        id,
        tanque_nombre,
        capacidad_total,
        nivel_actual,
        fecha_actualizacion,
        ROUND((nivel_actual / capacidad_total) * 100, 2) AS porcentaje
      FROM combustible
      WHERE id = $1 AND tenant_id = $2
    `,
      [id, tenantId]
    );

    return result.rows[0] || null;
  }

  /** Registra una lectura histórica y actualiza `nivel_actual` SOLO si esta
   *  lectura es más reciente que la ya aplicada -- compara contra
   *  `fecha_actualizacion` (columna que ya existe en `combustible`, no se
   *  crea una nueva). El UPDATE condicional es atómico: dos lecturas
   *  sincronizando casi al mismo tiempo (offline, orden de llegada
   *  arbitrario) nunca dejan `nivel_actual` en un valor más viejo que el
   *  que ya tenía, sin necesidad de un lock explícito -- mismo criterio que
   *  `IpercRepository.cambiarEstado` (UPDATE ... WHERE <condición> RETURNING).
   *
   *  Lanza si `combustibleId` no existe en este tenant -- el controller lo
   *  distingue de un 500 genérico (mismo patrón que
   *  `IpercController.crear` con `linea_base_item_id`). */
  async registrarLectura(
    client: PoolClient,
    tenantId: string,
    data: {
      combustibleId: number;
      nivel: number;
      leidoEn: string;
      usuarioId: string | null;
      metadata: Record<string, unknown>;
    }
  ) {
    const tanqueExiste = await client.query<{ id: number }>(
      `SELECT id FROM combustible WHERE id = $1 AND tenant_id = $2`,
      [data.combustibleId, tenantId]
    );
    if (tanqueExiste.rows.length === 0) {
      throw new Error(`combustible_id ${data.combustibleId} no existe en este tenant`);
    }

    const lectura = await client.query(
      `
      INSERT INTO combustible_lecturas
        (tenant_id, combustible_id, nivel, leido_en, usuario_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, combustible_id, nivel, leido_en, usuario_id, origen, metadata, creado_en
    `,
      [
        tenantId,
        data.combustibleId,
        data.nivel,
        data.leidoEn,
        data.usuarioId,
        JSON.stringify(data.metadata),
      ]
    );

    await client.query(
      `
      UPDATE combustible
      SET nivel_actual = $1, fecha_actualizacion = $2
      WHERE id = $3 AND tenant_id = $4 AND fecha_actualizacion < $2
    `,
      [data.nivel, data.leidoEn, data.combustibleId, tenantId]
    );

    const tanque = await this.findById(client, tenantId, data.combustibleId);
    return { lectura: lectura.rows[0], tanque };
  }

  /** Para el reintento de una lectura ya creada (mismo cliente_uuid) --
   *  responde igual que la primera vez, sin volver a tocar `combustible`. */
  async findLecturaConTanque(client: PoolClient, tenantId: string, lecturaId: number) {
    const lectura = await client.query(
      `SELECT id, combustible_id, nivel, leido_en, usuario_id, origen, metadata, creado_en
       FROM combustible_lecturas
       WHERE id = $1 AND tenant_id = $2`,
      [lecturaId, tenantId]
    );
    if (lectura.rows.length === 0) return null;

    const tanque = await this.findById(client, tenantId, lectura.rows[0].combustible_id);
    return { lectura: lectura.rows[0], tanque };
  }
}
