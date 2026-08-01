/** src/modules/iperc/iperc.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import type { CrearIpercInput, CambiarEstadoIpercInput } from "../../server/schemas/iperc.schema";
import { IpercService } from "./iperc.service";

export const IpercController = {

  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) => IpercService.getAll(client, tenantId, paginacion));
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ message: "Error al obtener IPERC" });
    }
  },

  async getById(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const iperc = await withTenant(tenantId, (client) => IpercService.getById(client, tenantId, Number(req.params.id)));
      if (!iperc) {
        res.status(404).json({ message: "IPERC no encontrado" });
        return;
      }
      res.json(iperc);
    } catch {
      res.status(500).json({ message: "Error al obtener IPERC" });
    }
  },

  async crear(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearIpercInput;
      const iperc = await withTenant(tenantId, (client) => IpercService.crear(client, tenantId, req.usuario!.id, data));
      res.status(201).json(iperc);
    } catch {
      res.status(500).json({ message: "Error al crear IPERC" });
    }
  },

  async cambiarEstado(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const { estado } = req.validatedBody as CambiarEstadoIpercInput;
      const iperc = await withTenant(tenantId, (client) =>
        IpercService.cambiarEstado(client, tenantId, Number(req.params.id), estado, req.usuario!.id)
      );
      if (!iperc) {
        res.status(404).json({ message: "IPERC no encontrado" });
        return;
      }
      res.json(iperc);
    } catch {
      res.status(500).json({ message: "Error al cambiar estado del IPERC" });
    }
  },

  async eliminar(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const eliminado = await withTenant(tenantId, (client) => IpercService.eliminar(client, tenantId, Number(req.params.id)));
      if (!eliminado) {
        res.status(404).json({ message: "IPERC no encontrado" });
        return;
      }
      res.json({ message: "Eliminado" });
    } catch {
      res.status(500).json({ message: "Error al eliminar IPERC" });
    }
  },
};
