/**src/modules/documentos/documentos.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";

// Sin schema de validación (ver documentos.routes.ts: req.body pasa directo,
// sin `validate()`) -- este tipo documenta la forma asumida por las queries
// de abajo, no agrega validación en runtime.
export type DocumentoPayload = {
  nombre_documento: string;
  responsable: string;
  fecha_vencimiento: string;
  estado?: string;
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
  async create(client: PoolClient, tenantId: string, data: DocumentoPayload) {
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
  async update(client: PoolClient, tenantId: string, id: number, data: DocumentoPayload) {
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
  async bulkCreate(client: PoolClient, tenantId: string, items: DocumentoPayload[]) {
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
