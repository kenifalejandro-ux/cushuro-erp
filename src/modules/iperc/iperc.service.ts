/** src/modules/iperc/iperc.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type { CrearIpercInput } from "../../server/schemas/iperc.schema";
import { IpercRepository } from "./iperc.repository";

export const IpercService = {
  getAll(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return IpercRepository.findAll(client, tenantId, paginacion);
  },

  getById(client: PoolClient, tenantId: string, id: number) {
    return IpercRepository.findById(client, tenantId, id);
  },

  crear(client: PoolClient, tenantId: string, usuarioId: string, data: CrearIpercInput) {
    return IpercRepository.crear(client, tenantId, usuarioId, data);
  },

  cambiarEstado(client: PoolClient, tenantId: string, id: number, estado: "aprobado" | "rechazado", aprobadoPor: string) {
    return IpercRepository.cambiarEstado(client, tenantId, id, estado, aprobadoPor);
  },

  eliminar(client: PoolClient, tenantId: string, id: number) {
    return IpercRepository.eliminar(client, tenantId, id);
  },
};
