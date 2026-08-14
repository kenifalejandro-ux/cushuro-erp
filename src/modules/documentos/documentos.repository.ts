/**src/modules/documentos/documentos.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";

// La validación en runtime la hacen los schemas de Zod en las rutas (ver
// server/schemas/documentos.schema.ts) -- este tipo solo describe la forma
// que asumen las queries de abajo.
//
// `responsable` admite undefined además de null porque los schemas lo
// declaran `.optional()`: quien no lo manda deja la columna en NULL, y las
// queries normalizan con `?? null` antes de pasarlo a pg.
export type DocumentoPayload = {
  nombre_documento: string;
  responsable?: string | null;
  fecha_vencimiento: string;
  estado?: string;
  orden_trabajo_id?: number | null;
};

export type DocumentoVersionPayload = {
  storage_driver: "local" | "s3";
  storage_key: string;
  mime_type: string;
  tamano_bytes: number;
  nombre_original: string;
  subido_por: string | null;
};

export const DocumentosRepository = {
  // ============================================================
  // 📄 GET /documentos/:id
  // ============================================================
  async findById(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query("SELECT * FROM documentos WHERE id = $1 AND tenant_id = $2", [
      id,
      tenantId,
    ]);
    return result.rows[0] ?? null;
  },

  // ============================================================
  // 📄 GET /documentos
  // LISTAR DOCUMENTOS (del tenant activo, paginado)
  // ============================================================
  async findAll(
    client: PoolClient,
    tenantId: string,
    { pageSize, offset }: Paginacion,
    ordenTrabajoId?: number
  ) {
    const params: (string | number)[] = [tenantId];
    let filtro = "";
    if (ordenTrabajoId) {
      params.push(ordenTrabajoId);
      filtro = ` AND orden_trabajo_id = $${params.length}`;
    }
    params.push(pageSize, offset);

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
        WHERE tenant_id = $1${filtro}
        ORDER BY fecha_vencimiento ASC NULLS LAST
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    return result.rows;
  },

  // ============================================================
  // 📄 POST /documentos
  // CREAR DOCUMENTO
  // ============================================================
  async create(client: PoolClient, tenantId: string, data: DocumentoPayload) {
    const { nombre_documento, responsable, fecha_vencimiento, orden_trabajo_id } = data;

    const result = await client.query(
      `
      INSERT INTO documentos
      (tenant_id, nombre_documento, responsable, fecha_vencimiento, orden_trabajo_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `,
      [tenantId, nombre_documento, responsable, fecha_vencimiento, orden_trabajo_id ?? null]
    );

    return result.rows[0];
  },

  // ============================================================
  // ✏️ PUT /documentos/:id
  // ACTUALIZAR DOCUMENTO (solo si pertenece al tenant activo)
  // ============================================================
  async update(client: PoolClient, tenantId: string, id: number, data: DocumentoPayload) {
    const { nombre_documento, responsable, fecha_vencimiento, estado, orden_trabajo_id } = data;

    const result = await client.query(
      `
      UPDATE documentos
      SET
        nombre_documento = $1,
        responsable = $2,
        fecha_vencimiento = $3,
        estado = $4,
        orden_trabajo_id = $5
      WHERE id = $6 AND tenant_id = $7
      RETURNING *
    `,
      [
        nombre_documento,
        responsable ?? null,
        fecha_vencimiento,
        estado ?? null,
        orden_trabajo_id ?? null,
        id,
        tenantId,
      ]
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

  // ============================================================
  // 🔍 GET /documentos/duplicado -- aviso (no bloqueo) al crear
  // ============================================================
  /** Mismo nombre Y misma fecha de vencimiento -- no solo el nombre: una
   *  renovación normal (SOAT vencido que se vuelve a cargar con fecha
   *  nueva) tiene el mismo nombre pero OTRA fecha, y no es un duplicado.
   *  Comparación insensible a mayúsculas/espacios para no dejar pasar
   *  "SOAT camión 12" vs "soat camión 12 " como si fueran distintos. */
  async findDuplicado(
    client: PoolClient,
    tenantId: string,
    nombreDocumento: string,
    fechaVencimiento: string
  ) {
    const result = await client.query(
      `SELECT id, nombre_documento, responsable, fecha_vencimiento
       FROM documentos
       WHERE tenant_id = $1
         AND LOWER(TRIM(nombre_documento)) = LOWER(TRIM($2))
         AND fecha_vencimiento = $3
       LIMIT 1`,
      [tenantId, nombreDocumento, fechaVencimiento]
    );
    return result.rows[0] ?? null;
  },

  // 📦 CARGA MASIVA
  /** Inserta todas las filas en UNA sola sentencia, no en un loop de N
   *  INSERT. La diferencia importa por multi-tenancy, no por microsegundos:
   *  cada round-trip a Postgres mantiene tomada una conexión del pool
   *  COMPARTIDO entre todos los tenants, así que una importación de 5.000
   *  filas en loop bloquea esa conexión 5.000 viajes de red seguidos y le
   *  sube la latencia a los demás clientes. Con una sola sentencia es un
   *  viaje.
   *
   *  Se inserta en lotes de 1.000 y no todo junto porque Postgres tiene un
   *  tope duro de 65.535 parámetros por sentencia: con 4 columnas por fila,
   *  el techo real está en ~16.000 filas. El lote de 1.000 (4.000
   *  parámetros) deja margen de sobra y mantiene acotado el tamaño de cada
   *  sentencia. Todos los lotes van en la MISMA transacción (el `client` lo
   *  abre withTenant), así que la importación sigue siendo todo-o-nada. */
  async bulkCreate(client: PoolClient, tenantId: string, items: DocumentoPayload[]) {
    const TAMANO_LOTE = 1000;
    let insertadas = 0;

    for (let inicio = 0; inicio < items.length; inicio += TAMANO_LOTE) {
      const lote = items.slice(inicio, inicio + TAMANO_LOTE);

      // ($1,$2,$3,$4), ($5,$6,$7,$8), ... -- los valores SIEMPRE
      // parametrizados, nunca interpolados en el SQL.
      const placeholders = lote
        .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
        .join(", ");

      const valores = lote.flatMap((d) => [
        tenantId,
        d.nombre_documento,
        d.responsable ?? null,
        d.fecha_vencimiento,
      ]);

      const result = await client.query(
        `INSERT INTO documentos (tenant_id, nombre_documento, responsable, fecha_vencimiento)
         VALUES ${placeholders}`,
        valores
      );
      insertadas += result.rowCount ?? 0;
    }

    return insertadas;
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

  // ============================================================
  // 📎 ARCHIVO ADJUNTO (documentos_versiones, ver migración 0043)
  // ============================================================

  async insertVersion(
    client: PoolClient,
    tenantId: string,
    documentoId: number,
    data: DocumentoVersionPayload
  ) {
    const result = await client.query(
      `
      INSERT INTO documentos_versiones
      (tenant_id, documento_id, storage_driver, storage_key, mime_type, tamano_bytes, nombre_original, subido_por)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `,
      [
        tenantId,
        documentoId,
        data.storage_driver,
        data.storage_key,
        data.mime_type,
        data.tamano_bytes,
        data.nombre_original,
        data.subido_por,
      ]
    );
    return result.rows[0];
  },

  async findVersiones(client: PoolClient, tenantId: string, documentoId: number) {
    const result = await client.query(
      `SELECT id, mime_type, tamano_bytes, nombre_original, subido_por, subido_en
       FROM documentos_versiones
       WHERE tenant_id = $1 AND documento_id = $2
       ORDER BY subido_en DESC`,
      [tenantId, documentoId]
    );
    return result.rows;
  },

  /** Ubicación en el storage de TODAS las versiones de un documento --
   *  para poder borrar los archivos después de borrar el documento (si no,
   *  el ON DELETE CASCADE se lleva las filas y los archivos quedan
   *  huérfanos en R2/disco, ocupando espacio sin que nada los referencie).
   *  Uso interno, nunca se devuelve al cliente. */
  async findStorageDeVersiones(client: PoolClient, tenantId: string, documentoId: number) {
    const result = await client.query<{ storage_driver: "local" | "s3"; storage_key: string }>(
      `SELECT storage_driver, storage_key FROM documentos_versiones
       WHERE tenant_id = $1 AND documento_id = $2`,
      [tenantId, documentoId]
    );
    return result.rows;
  },

  /** Trae la versión completa (incluida storage_key/driver, que las otras
   *  queries de arriba no exponen) -- solo para uso interno al armar la
   *  descarga, nunca se devuelve tal cual al cliente. */
  async findVersion(client: PoolClient, tenantId: string, documentoId: number, versionId: number) {
    const result = await client.query(
      `SELECT * FROM documentos_versiones
       WHERE id = $1 AND documento_id = $2 AND tenant_id = $3`,
      [versionId, documentoId, tenantId]
    );
    return result.rows[0] ?? null;
  },
};
