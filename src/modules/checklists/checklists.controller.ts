/** src/modules/checklists/checklists.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import type { CrearPlantillaInput, CrearChecklistInput } from "../../server/schemas/checklists.schema";
import { ChecklistsService } from "./checklists.service";

export const ChecklistsController = {

  async getPlantillas(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) => ChecklistsService.getPlantillas(client, tenantId, paginacion));
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ message: "Error al obtener plantillas" });
    }
  },

  async getPlantilla(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const plantilla = await withTenant(tenantId, (client) =>
        ChecklistsService.getPlantilla(client, tenantId, Number(req.params.id))
      );
      if (!plantilla) {
        res.status(404).json({ message: "Plantilla no encontrada" });
        return;
      }
      res.json(plantilla);
    } catch {
      res.status(500).json({ message: "Error al obtener plantilla" });
    }
  },

  async crearPlantilla(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearPlantillaInput;
      const plantilla = await withTenant(tenantId, (client) => ChecklistsService.crearPlantilla(client, tenantId, data));
      res.status(201).json(plantilla);
    } catch {
      res.status(500).json({ message: "Error al crear plantilla" });
    }
  },

  async eliminarPlantilla(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const eliminado = await withTenant(tenantId, (client) =>
        ChecklistsService.eliminarPlantilla(client, tenantId, Number(req.params.id))
      );
      if (!eliminado) {
        res.status(404).json({ message: "Plantilla no encontrada" });
        return;
      }
      res.json({ message: "Eliminada" });
    } catch {
      res.status(500).json({ message: "Error al eliminar plantilla" });
    }
  },

  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) => ChecklistsService.getAll(client, tenantId, paginacion));
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ message: "Error al obtener checklists" });
    }
  },

  async getById(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const checklist = await withTenant(tenantId, (client) =>
        ChecklistsService.getById(client, tenantId, Number(req.params.id))
      );
      if (!checklist) {
        res.status(404).json({ message: "Checklist no encontrado" });
        return;
      }
      res.json(checklist);
    } catch {
      res.status(500).json({ message: "Error al obtener checklist" });
    }
  },

  async crear(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearChecklistInput;
      const checklist = await withTenant(tenantId, (client) =>
        ChecklistsService.crear(client, tenantId, req.usuario!.id, data)
      );
      res.status(201).json(checklist);
    } catch {
      res.status(500).json({ message: "Error al crear checklist" });
    }
  },

  async eliminar(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const eliminado = await withTenant(tenantId, (client) =>
        ChecklistsService.eliminar(client, tenantId, Number(req.params.id))
      );
      if (!eliminado) {
        res.status(404).json({ message: "Checklist no encontrado" });
        return;
      }
      res.json({ message: "Eliminado" });
    } catch {
      res.status(500).json({ message: "Error al eliminar checklist" });
    }
  },
};
