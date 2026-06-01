/**src/modules/combutible/combustible.controller.ts */

import { Request, Response } from "express";
import { CombustibleService } from "./combustible.service";

const service = new CombustibleService();

export class CombustibleController {

  async getAll(req: Request, res: Response) {
    try {
      const data = await service.getAll();
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Error al obtener combustible" });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const id = Number(req.params.id);
      const data = await service.getById(id);

      if (!data) {
        return res.status(404).json({ error: "No encontrado" });
      }

      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Error al obtener combustible" });
    }
  }

  async updateNivel(req: Request, res: Response) {
    try {
      const id = Number(req.params.id);
      const { nivel_actual } = req.body;

      const updated = await service.updateNivel(id, nivel_actual);

      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Error al actualizar nivel" });
    }
  }
}