/** src/modules/iperc/iperc.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type { CrearIpercInput, CrearLineaBaseInput } from "../../server/schemas/iperc.schema";
import { IpercRepository } from "./iperc.repository";

export const IpercService = {
  getAll(client: PoolClient, tenantId: string, paginacion: Paginacion, tipo?: string) {
    return IpercRepository.findAll(client, tenantId, paginacion, tipo);
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

  // ── Línea Base ───────────────────────────────────────────────────────
  getLineasBase(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return IpercRepository.findLineasBase(client, tenantId, paginacion);
  },

  getLineaBase(client: PoolClient, tenantId: string, id: number) {
    return IpercRepository.findLineaBaseConItems(client, tenantId, id);
  },

  crearLineaBase(client: PoolClient, tenantId: string, creadoPor: string, data: CrearLineaBaseInput) {
    return IpercRepository.crearLineaBase(client, tenantId, creadoPor, data);
  },

  cambiarEstadoLineaBase(client: PoolClient, tenantId: string, id: number, estado: "aprobado" | "rechazado", aprobadoPor: string) {
    return IpercRepository.cambiarEstadoLineaBase(client, tenantId, id, estado, aprobadoPor);
  },

  eliminarLineaBase(client: PoolClient, tenantId: string, id: number) {
    return IpercRepository.eliminarLineaBase(client, tenantId, id);
  },
};
