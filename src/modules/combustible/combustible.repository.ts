/**src/modules/combutible/combustible.repository.ts */

import type { PoolClient } from "pg";
import type {
  CrearTanqueCombustibleInput,
  ActualizarTanqueCombustibleInput,
} from "../../server/schemas/combustible.schema";
import type { Paginacion } from "../../server/shared/utils/pagination";

// Columnas comunes a findAll/findById/create/update/delete -- un tanque es
// el punto de abastecimiento completo, no solo el medidor de antes de la
// Fase A (ver docs/architecture/control-de-combustible.md).
const COLUMNAS_TANQUE = `
  id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, ubicacion,
  capacidad_total, nivel_actual, nivel_minimo, totalizador_actual,
  costo_promedio, moneda, activo, fecha_actualizacion,
  ROUND((nivel_actual / capacidad_total) * 100, 2) AS porcentaje
`;

export class CombustibleRepository {
  async findAll(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `SELECT ${COLUMNAS_TANQUE} FROM combustible WHERE tenant_id = $1 ORDER BY id ASC`,
      [tenantId]
    );

    return result.rows;
  }

  async findById(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `SELECT ${COLUMNAS_TANQUE} FROM combustible WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );

    return result.rows[0] || null;
  }

  /** `nivel_actual` NO se toca acá -- nace en 0 y solo se mueve por
   *  POST /lecturas (ver registrarLectura más abajo), igual que
   *  `totalizador_actual` (Fase B) y `costo_promedio` (Fase C). Si el
   *  alta trae un `nivel_actual` inicial (ver crearTanqueCombustibleSchema),
   *  se aplica acá mismo porque todavía no existe ninguna lectura previa
   *  que este INSERT pudiera pisar. */
  async create(client: PoolClient, tenantId: string, data: CrearTanqueCombustibleInput) {
    const result = await client.query(
      `
      INSERT INTO combustible (
        tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto,
        ubicacion, capacidad_total, nivel_actual, nivel_minimo, moneda,
        fecha_actualizacion
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      RETURNING ${COLUMNAS_TANQUE}
      `,
      [
        tenantId,
        data.codigo,
        data.tanque_nombre,
        data.tipo_combustible,
        data.unidad,
        data.tipo_punto,
        data.ubicacion ?? null,
        data.capacidad_total,
        data.nivel_actual,
        data.nivel_minimo,
        data.moneda,
      ]
    );

    return result.rows[0];
  }

  /** Reemplaza la fila entera salvo `nivel_actual`/`totalizador_actual`/
   *  `costo_promedio` -- mismo motivo que en create(): esos tres tienen su
   *  propio camino de escritura, este endpoint no es ese camino. */
  async update(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: ActualizarTanqueCombustibleInput
  ) {
    const result = await client.query(
      `
      UPDATE combustible SET
        codigo = $1,
        tanque_nombre = $2,
        tipo_combustible = $3,
        unidad = $4,
        tipo_punto = $5,
        ubicacion = $6,
        capacidad_total = $7,
        nivel_minimo = $8,
        moneda = $9,
        activo = $10
      WHERE id = $11 AND tenant_id = $12
      RETURNING ${COLUMNAS_TANQUE}
      `,
      [
        data.codigo,
        data.tanque_nombre,
        data.tipo_combustible,
        data.unidad,
        data.tipo_punto,
        data.ubicacion ?? null,
        data.capacidad_total,
        data.nivel_minimo,
        data.moneda,
        data.activo,
        id,
        tenantId,
      ]
    );

    return result.rows[0] ?? null;
  }

  /** Soft-delete exclusivamente: `combustible_lecturas.combustible_id`
   *  tiene ON DELETE CASCADE (0045_combustible_lecturas.sql) -- un DELETE
   *  real de SQL borraría en cascada todo el historial de lecturas del
   *  tanque. Desactivar dejando la fila (y su historial) intactos es la
   *  única forma segura de "eliminar" un tanque acá. */
  async softDelete(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `UPDATE combustible SET activo = false WHERE id = $1 AND tenant_id = $2
       RETURNING ${COLUMNAS_TANQUE}`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  /** Mismo patrón de lote de 1.000 + dedupe por `codigo` DENTRO del lote
   *  que RepuestosRepository.createBulk -- ver el comentario largo ahí. En
   *  la práctica un tenant nunca va a acercarse al tamaño de lote (los
   *  tanques son unos pocos por sitio), pero el molde es el mismo por
   *  consistencia y porque el tope real está en el schema (Zod), no acá. */
  async createBulk(client: PoolClient, tenantId: string, items: CrearTanqueCombustibleInput[]) {
    const TAMANO_LOTE = 1000;
    const results: unknown[] = [];

    for (let inicio = 0; inicio < items.length; inicio += TAMANO_LOTE) {
      const lote = items.slice(inicio, inicio + TAMANO_LOTE);

      const porCodigo = new Map<string, CrearTanqueCombustibleInput>();
      for (const fila of lote) porCodigo.set(fila.codigo, fila);
      const filasUnicas = [...porCodigo.values()];

      const placeholders = filasUnicas
        .map((_, i) => {
          const base = i * 10;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, NOW())`;
        })
        .join(", ");

      const valores = filasUnicas.flatMap((d) => [
        tenantId,
        d.codigo,
        d.tanque_nombre,
        d.tipo_combustible,
        d.unidad,
        d.tipo_punto,
        d.ubicacion ?? null,
        d.capacidad_total,
        d.nivel_actual,
        d.nivel_minimo,
      ]);

      const result = await client.query(
        `INSERT INTO combustible (
           tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto,
           ubicacion, capacidad_total, nivel_actual, nivel_minimo, fecha_actualizacion
         )
         VALUES ${placeholders}
         ON CONFLICT (tenant_id, codigo) DO UPDATE SET
           tanque_nombre = EXCLUDED.tanque_nombre,
           tipo_combustible = EXCLUDED.tipo_combustible,
           unidad = EXCLUDED.unidad,
           tipo_punto = EXCLUDED.tipo_punto,
           ubicacion = EXCLUDED.ubicacion,
           capacidad_total = EXCLUDED.capacidad_total,
           nivel_minimo = EXCLUDED.nivel_minimo
         RETURNING ${COLUMNAS_TANQUE}`,
        valores
      );
      results.push(...result.rows);
    }

    return results;
  }

  /** GET /:id/lecturas -- a diferencia de los tanques (pocos, sin
   *  paginación), el histórico de lecturas SÍ crece con el trabajo de
   *  campo, mismo criterio que combustible_lecturas ya tiene declarada su
   *  propia cuota en el registry. */
  async findLecturas(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    { pageSize, offset }: Paginacion
  ) {
    const result = await client.query(
      `
      SELECT id, combustible_id, nivel, leido_en, usuario_id, origen, metadata, creado_en,
        COUNT(*) OVER() AS total_count
      FROM combustible_lecturas
      WHERE combustible_id = $1 AND tenant_id = $2
      ORDER BY leido_en DESC
      LIMIT $3 OFFSET $4
      `,
      [combustibleId, tenantId, pageSize, offset]
    );

    return result.rows;
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
