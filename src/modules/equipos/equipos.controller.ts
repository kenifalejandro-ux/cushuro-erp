/** src/modules/equipos/equipos.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { EquiposService } from "./equipos.service";

export const EquiposController = {
  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        EquiposService.getAll(client, tenantId, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ message: "Error al obtener equipos" });
    }
  },

  async create(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const nuevo = await withTenant(tenantId, (client) =>
        EquiposService.create(client, tenantId, req.body)
      );
      await registrarAuditoria({
        accion: "equipos.crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { equipoId: nuevo.id },
        contexto: contextoAuditoriaModulo(req),
      });
      res.status(201).json(nuevo);
    } catch {
      res.status(500).json({ message: "Error al crear equipo" });
    }
  },

  async update(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const actualizado = await withTenant(tenantId, (client) =>
        EquiposService.update(client, tenantId, id, req.body)
      );

      if (!actualizado) {
        res.status(404).json({ message: "Equipo no encontrado" });
        return;
      }
      await registrarAuditoria({
        accion: "equipos.actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { equipoId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      res.json(actualizado);
    } catch {
      res.status(500).json({ message: "Error al actualizar equipo" });
    }
  },

  async delete(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const eliminado = await withTenant(tenantId, (client) =>
        EquiposService.delete(client, tenantId, id)
      );

      if (!eliminado) {
        res.status(404).json({ message: "Equipo no encontrado" });
        return;
      }
      await registrarAuditoria({
        accion: "equipos.eliminar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { equipoId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      res.json({ message: "Eliminado" });
    } catch {
      res.status(500).json({ message: "Error al eliminar equipo" });
    }
  },
};
