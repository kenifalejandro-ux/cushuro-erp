/** src/modules/documentos/documentos.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import { DocumentosRepository } from "./documentos.repository";

export const DocumentosService = {

  getAll(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return DocumentosRepository.findAll(client, tenantId, paginacion);
  },

  create(client: PoolClient, tenantId: string, data: any) {
    return DocumentosRepository.create(client, tenantId, data);
  },

  update(client: PoolClient, tenantId: string, id: number, data: any) {
    return DocumentosRepository.update(client, tenantId, id, data);
  },

  delete(client: PoolClient, tenantId: string, id: number) {
    return DocumentosRepository.delete(client, tenantId, id);
  },

  bulkCreate(client: PoolClient, tenantId: string, data: any[]) {
    return DocumentosRepository.bulkCreate(client, tenantId, data);
  },

  getKPIs(client: PoolClient, tenantId: string) {
    return DocumentosRepository.getKPIs(client, tenantId);
  }

};
