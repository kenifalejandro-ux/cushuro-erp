/**src/modules/combutible/combustible.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { CombustibleService } from "./combustible.service";

const service = new CombustibleService();

export class CombustibleController {
  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) => service.getAll(client, tenantId));
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error al obtener combustible" });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));

      if (!data) {
        return res.status(404).json({ error: "No encontrado" });
      }

      res.json(data);
    } catch {
      res.status(500).json({ error: "Error al obtener combustible" });
    }
  }

  async updateNivel(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { nivel_actual } = req.body;

      const updated = await withTenant(tenantId, (client) =>
        service.updateNivel(client, tenantId, id, nivel_actual)
      );

      if (!updated) {
        return res.status(404).json({ error: "No encontrado" });
      }

      res.json(updated);
    } catch {
      res.status(500).json({ error: "Error al actualizar nivel" });
    }
  }
}
