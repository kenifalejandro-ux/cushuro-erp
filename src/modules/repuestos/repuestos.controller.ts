/**src/modules/repuestos/repuestos.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { RepuestosService } from "./repuestos.service";

export const RepuestosController = {

  // =========================
  // 📥 OBTENER TODO (paginado)
  // =========================
  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) => RepuestosService.getAll(client, tenantId, paginacion));
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ message: "Error al obtener repuestos" });
    }
  },

  // =========================
  // ➕ CREAR REPUESTO
  // =========================
  async create(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const nuevo = await withTenant(tenantId, (client) => RepuestosService.create(client, tenantId, req.body));
      res.status(201).json(nuevo);
    } catch {
      res.status(500).json({ message: "Error al crear repuesto" });
    }
  },

  // =========================
  // ✏️ ACTUALIZAR REPUESTO
  // =========================
  async update(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = req.body;

      const actualizado = await withTenant(tenantId, (client) => RepuestosService.update(client, tenantId, id, data));

      if (!actualizado) {
        res.status(404).json({ message: "Repuesto no encontrado" });
        return;
      }

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
      const tenantId = getTenantId(req);
      const eliminado = await withTenant(tenantId, (client) => RepuestosService.delete(client, tenantId, Number(req.params.id)));

      if (!eliminado) {
        res.status(404).json({ message: "Repuesto no encontrado" });
        return;
      }

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
      const tenantId = getTenantId(req);
      const rows = req.body;
      if (!Array.isArray(rows)) {
        res.status(400).json({ message: "Se esperaba un array de repuestos" });
        return;
      }
      const result = await withTenant(tenantId, (client) => RepuestosService.createBulk(client, tenantId, rows));
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
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) => RepuestosService.getKPIs(client, tenantId));
      res.json(data);
    } catch {
      res.status(500).json({ message: "Error KPIs" });
    }
  }
};
