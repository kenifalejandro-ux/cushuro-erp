/** src/modules/documentos/documentos.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type { CrearDocumentoInput } from "../../server/schemas/documentos.schema";
import { withTenant } from "../../server/config/database";
import { logger } from "../../server/config/logger";
import { idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import {
  borrarArchivoDocumento,
  construirKeyDocumento,
  guardarArchivoDocumento,
  obtenerDescarga,
} from "../../server/services/documentStorage";
import { DocumentosRepository, type DocumentoPayload } from "./documentos.repository";

export const DocumentosService = {
  getAll(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return DocumentosRepository.findAll(client, tenantId, paginacion);
  },

  verificarDuplicado(
    client: PoolClient,
    tenantId: string,
    nombreDocumento: string,
    fechaVencimiento: string
  ) {
    return DocumentosRepository.findDuplicado(client, tenantId, nombreDocumento, fechaVencimiento);
  },

  /** Devuelve `creado: false` cuando este documento ya se había creado con
   *  el mismo `cliente_uuid` -- el reintento de un envío cuya respuesta se
   *  perdió (ver idempotentInsert.ts). El controller usa ese flag para no
   *  publicar el evento de nuevo. Sin `cliente_uuid` en el body, se
   *  comporta igual que antes: siempre crea. */
  create(client: PoolClient, tenantId: string, data: CrearDocumentoInput) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "documentos",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        const fila = await DocumentosRepository.create(client, tenantId, {
          nombre_documento: data.nombre_documento,
          responsable: data.responsable ?? null,
          fecha_vencimiento: data.fecha_vencimiento,
        });
        return { id: fila.id as number, fila };
      },
      recuperar: (filaId) => DocumentosRepository.findById(client, tenantId, filaId),
    });
  },

  update(client: PoolClient, tenantId: string, id: number, data: DocumentoPayload) {
    return DocumentosRepository.update(client, tenantId, id, data);
  },

  /** Borra el documento y, recién DESPUÉS de que ese borrado commiteó,
   *  borra también los archivos de sus versiones del storage.
   *
   *  El orden importa en las dos direcciones: borrar los archivos antes
   *  del commit los perdería si la transacción termina en rollback (el
   *  documento seguiría existiendo, sin sus adjuntos); no borrarlos nunca
   *  los deja huérfanos en R2/disco, ocupando espacio sin que ninguna fila
   *  los referencie (el ON DELETE CASCADE de documentos_versiones se lleva
   *  las filas, pero no puede tocar el storage).
   *
   *  Un fallo borrando un archivo NO falla el request: el documento ya se
   *  borró de verdad: mismo contrato best-effort que registrarAuditoria()
   *  y publicarEventoTenant(). Queda un huérfano y un warning en el log,
   *  que es estrictamente mejor que devolverle un 500 a quien pidió algo
   *  que sí se hizo. */
  async delete(tenantId: string, id: number) {
    const archivos = await withTenant(tenantId, async (client) => {
      const versiones = await DocumentosRepository.findStorageDeVersiones(client, tenantId, id);
      const eliminado = await DocumentosRepository.delete(client, tenantId, id);
      return eliminado ? versiones : null;
    });

    if (archivos === null) return false;

    for (const archivo of archivos) {
      try {
        await borrarArchivoDocumento(archivo.storage_driver, archivo.storage_key);
      } catch (err) {
        logger.warn(
          { err, documentoId: id, key: archivo.storage_key },
          "No se pudo borrar el archivo de una versión al borrar el documento (queda huérfano en el storage)"
        );
      }
    }

    return true;
  },

  bulkCreate(client: PoolClient, tenantId: string, data: DocumentoPayload[]) {
    return DocumentosRepository.bulkCreate(client, tenantId, data);
  },

  getKPIs(client: PoolClient, tenantId: string) {
    return DocumentosRepository.getKPIs(client, tenantId);
  },

  // ============================================================
  // 📎 ARCHIVO ADJUNTO
  // ============================================================

  /** Sube el archivo AFUERA de cualquier transacción (la subida a R2 es una
   *  llamada de red que puede tardar; no tiene sentido tener una conexión
   *  de Postgres bloqueada mientras tanto) y solo abre una transacción corta
   *  para el INSERT -- mismo criterio que platformBackup.service.ts con
   *  guardarBackup(). Si el documento no existe, no se sube nada (`null`,
   *  mismo criterio de "no encontrado" que update()/delete() de este mismo
   *  archivo).
   *
   *  `clienteUuid` participa de offline (Caso B, ver ADR-0002 §8): un
   *  reintento con el mismo valor no crea una segunda fila. SÍ vuelve a
   *  subir el archivo al storage antes de que idempotentInsert() detecte
   *  el duplicado -- la subida pasa primero a propósito (no tiene sentido
   *  bloquear Postgres esperando R2), así que no hay forma barata de saber
   *  "esto ya se subió" sin subir primero. Un reintento (raro: la señal se
   *  corta justo después de que el servidor ya guardó) deja un archivo
   *  huérfano en el storage -- mismo criterio de "el huérfano es aceptable"
   *  que ya usa delete() más abajo en este archivo. */
  async subirVersion(
    tenantId: string,
    documentoId: number,
    archivo: { buffer: Buffer; mimeType: string; nombreOriginal: string },
    subidoPor: string,
    clienteUuid?: string
  ) {
    const documento = await withTenant(tenantId, (client) =>
      DocumentosRepository.findById(client, tenantId, documentoId)
    );
    if (!documento) {
      return null;
    }

    const key = construirKeyDocumento(tenantId, documentoId, archivo.nombreOriginal);
    const { driver, bytes } = await guardarArchivoDocumento(key, archivo.buffer, archivo.mimeType);

    return withTenant(tenantId, (client) =>
      idempotentInsert({
        client,
        tenantId,
        modulo: "documentos",
        clienteUuid,
        insertar: async () => {
          const fila = await DocumentosRepository.insertVersion(client, tenantId, documentoId, {
            storage_driver: driver,
            storage_key: key,
            mime_type: archivo.mimeType,
            tamano_bytes: bytes,
            nombre_original: archivo.nombreOriginal,
            subido_por: subidoPor,
          });
          return { id: fila.id as number, fila };
        },
        recuperar: (filaId) =>
          DocumentosRepository.findVersion(client, tenantId, documentoId, filaId),
      })
    );
  },

  async listarVersiones(client: PoolClient, tenantId: string, documentoId: number) {
    const documento = await DocumentosRepository.findById(client, tenantId, documentoId);
    if (!documento) {
      return null;
    }
    return DocumentosRepository.findVersiones(client, tenantId, documentoId);
  },

  async obtenerDescargaVersion(
    client: PoolClient,
    tenantId: string,
    documentoId: number,
    versionId: number
  ) {
    const version = await DocumentosRepository.findVersion(
      client,
      tenantId,
      documentoId,
      versionId
    );
    if (!version) {
      return null;
    }

    const descarga = await obtenerDescarga(
      version.storage_driver,
      version.storage_key,
      version.nombre_original,
      version.mime_type
    );

    return { descarga, nombreOriginal: version.nombre_original, mimeType: version.mime_type };
  },
};
