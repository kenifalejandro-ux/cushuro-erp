/**src/modules/repuestos/repuestos.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import { RepuestosRepository } from "./repuestos.repository";

export const RepuestosService = {

  // 📥 traer todo (paginado)
  getAll(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return RepuestosRepository.findAll(client, tenantId, paginacion);
  },

  // ➕ crear
  create(client: PoolClient, tenantId: string, data: any) {
    return RepuestosRepository.create(client, tenantId, data);
  },

  // ✏️ actualizar
  update(client: PoolClient, tenantId: string, id: number, data: any) {
    return RepuestosRepository.update(client, tenantId, id, data);
  },

  // 🗑 eliminar
  delete(client: PoolClient, tenantId: string, id: number) {
    return RepuestosRepository.delete(client, tenantId, id);
  },

  // 📦 bulk
  createBulk(client: PoolClient, tenantId: string, rows: any[]) {
    return RepuestosRepository.createBulk(client, tenantId, rows);
  },

  // 📊 KPIs
  getKPIs(client: PoolClient, tenantId: string) {
    return RepuestosRepository.getDashboardKPIs(client, tenantId);
  }
};
