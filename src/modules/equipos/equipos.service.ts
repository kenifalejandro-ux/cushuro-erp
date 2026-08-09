/** src/modules/equipos/equipos.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import { EquiposRepository, type EquipoPayload } from "./equipos.repository";

export const EquiposService = {
  getAll(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return EquiposRepository.findAll(client, tenantId, paginacion);
  },

  create(client: PoolClient, tenantId: string, data: EquipoPayload) {
    return EquiposRepository.create(client, tenantId, data);
  },

  update(client: PoolClient, tenantId: string, id: number, data: EquipoPayload) {
    return EquiposRepository.update(client, tenantId, id, data);
  },

  delete(client: PoolClient, tenantId: string, id: number) {
    return EquiposRepository.delete(client, tenantId, id);
  },
};
