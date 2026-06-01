/**src/modules/repuestos/repuestos.controller.ts */

import { Request, Response } from "express";
import { RepuestosService } from "./repuestos.service";

export const RepuestosController = {

  // =========================
  // 📥 OBTENER TODO
  // =========================
  async getAll(req: Request, res: Response) {
    try {
      const data = await RepuestosService.getAll();
      res.json(data);
    } catch {
      res.status(500).json({ message: "Error al obtener repuestos" });
    }
  },

  // =========================
  // ➕ CREAR REPUESTO
  // =========================
  async create(req: Request, res: Response) {
    try {
      const nuevo = await RepuestosService.create(req.body);
      res.status(201).json(nuevo);
    } catch {
      res.status(500).json({ message: "Error al crear repuesto" });
    }
  },

  // =========================
  // ✏️ ACTUALIZAR REPUESTO (NUEVO)
  // =========================
  async update(req: Request, res: Response) {
    try {
      const id = Number(req.params.id);
      const data = req.body;

      const actualizado = await RepuestosService.update(id, data);

      res.json(actualizado);
    } catch {
      res.status(500).json({ message: "Error al actualizar repuesto" });
    }
  },

  // =========================
  // 🗑 ELIMINAR
  // =========================
  async delete(req: Request, res: Response) {
    try {
      await RepuestosService.delete(Number(req.params.id));
      res.json({ message: "Eliminado" });
    } catch {
      res.status(500).json({ message: "Error al eliminar" });
    }
  },

  // =========================
  // 📦 INSERCIÓN MASIVA
  // =========================
  async bulk(req: Request, res: Response) {
    try {
      const rows = req.body;
      if (!Array.isArray(rows)) {
        res.status(400).json({ message: "Se esperaba un array de repuestos" });
        return;
      }
      const result = await RepuestosService.createBulk(rows);
      res.status(201).json({ insertados: result.length, data: result });
    } catch {
      res.status(500).json({ message: "Error en importación masiva" });
    }
  },

  // =========================
  // 📊 KPIs
  // =========================
  async kpis(req: Request, res: Response) {
    try {
      const data = await RepuestosService.getKPIs();
      res.json(data);
    } catch {
      res.status(500).json({ message: "Error KPIs" });
    }
  }
};