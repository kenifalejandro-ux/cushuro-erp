/** src/modules/checklists/checklists.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion, CursorPaginacion } from "../../server/shared/utils/pagination";
import type {
  CrearPlantillaInput,
  CrearChecklistInput,
} from "../../server/schemas/checklists.schema";
import { ChecklistsRepository } from "./checklists.repository";

export const ChecklistsService = {
  getPlantillas(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return ChecklistsRepository.findPlantillas(client, tenantId, paginacion);
  },

  getPlantilla(client: PoolClient, tenantId: string, id: number) {
    return ChecklistsRepository.findPlantillaConItems(client, tenantId, id);
  },

  crearPlantilla(client: PoolClient, tenantId: string, data: CrearPlantillaInput) {
    return ChecklistsRepository.crearPlantilla(client, tenantId, data);
  },

  eliminarPlantilla(client: PoolClient, tenantId: string, id: number) {
    return ChecklistsRepository.eliminarPlantilla(client, tenantId, id);
  },

  getAll(client: PoolClient, tenantId: string, paginacion: CursorPaginacion) {
    return ChecklistsRepository.findAll(client, tenantId, paginacion);
  },

  getById(client: PoolClient, tenantId: string, id: number) {
    return ChecklistsRepository.findById(client, tenantId, id);
  },

  crear(client: PoolClient, tenantId: string, usuarioId: string, data: CrearChecklistInput) {
    return ChecklistsRepository.crear(client, tenantId, usuarioId, data);
  },

  eliminar(client: PoolClient, tenantId: string, id: number) {
    return ChecklistsRepository.eliminar(client, tenantId, id);
  },
};
