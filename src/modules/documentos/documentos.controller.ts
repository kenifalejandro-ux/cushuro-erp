/** src/modules/documentos/documentos.controller.ts */

import { Request, Response } from "express";
import { DocumentosService } from "./documentos.service";

export const DocumentosController = {

  // 📄 LISTAR TODOS LOS DOCUMENTOS
  async getAll(req: Request, res: Response) {
    try {
      const data = await DocumentosService.getAll();
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Error al obtener documentos" });
    }
  },

  // ➕ CREAR DOCUMENTO (manual o Excel)
  async create(req: Request, res: Response) {
    try {
      const data = await DocumentosService.create(req.body);
      res.status(201).json(data);
    } catch {
      res.status(500).json({ error: "Error al crear documento" });
    }
  },

  // ✏️ EDITAR DOCUMENTO
  async update(req: Request, res: Response) {
    try {
      const data = await DocumentosService.update(Number(req.params.id), req.body);
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error al actualizar documento" });
    }
  },

  // 🗑️ ELIMINAR DOCUMENTO
  async delete(req: Request, res: Response) {
    try {
      await DocumentosService.delete(Number(req.params.id));
      res.json({ message: "Eliminado correctamente" });
    } catch {
      res.status(500).json({ error: "Error al eliminar documento" });
    }
  },

  // 📊 CARGA MASIVA EXCEL (JSON)
  async bulkCreate(req: Request, res: Response) {
    try {
      const data = await DocumentosService.bulkCreate(req.body);
      res.status(201).json(data);
    } catch {
      res.status(500).json({ error: "Error en carga masiva" });
    }
  },

  // 📊 KPIs DASHBOARD
  async kpis(req: Request, res: Response) {
    try {
      const data = await DocumentosService.getKPIs();
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error en KPIs" });
    }
  }

};