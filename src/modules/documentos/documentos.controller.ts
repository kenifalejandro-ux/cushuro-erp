/** src/modules/documentos/documentos.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import { DocumentosService } from "./documentos.service";

export const DocumentosController = {
  // 📄 LISTAR DOCUMENTOS (paginado)
  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        DocumentosService.getAll(client, tenantId, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al obtener documentos" });
    }
  },

  // ➕ CREAR DOCUMENTO (manual o Excel)
  async create(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) =>
        DocumentosService.create(client, tenantId, req.body)
      );
      await publicarEventoTenant(tenantId, "documentos.creado", { documentoId: data.id });
      res.status(201).json(data);
    } catch {
      res.status(500).json({ error: "Error al crear documento" });
    }
  },

  // ✏️ EDITAR DOCUMENTO
  async update(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) =>
        DocumentosService.update(client, tenantId, Number(req.params.id), req.body)
      );

      if (!data) {
        res.status(404).json({ error: "Documento no encontrado" });
        return;
      }

      await publicarEventoTenant(tenantId, "documentos.actualizado", { documentoId: data.id });
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error al actualizar documento" });
    }
  },

  // 🗑️ ELIMINAR DOCUMENTO
  async delete(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const eliminado = await withTenant(tenantId, (client) =>
        DocumentosService.delete(client, tenantId, id)
      );

      if (!eliminado) {
        res.status(404).json({ error: "Documento no encontrado" });
        return;
      }

      await publicarEventoTenant(tenantId, "documentos.eliminado", { documentoId: id });
      res.json({ message: "Eliminado correctamente" });
    } catch {
      res.status(500).json({ error: "Error al eliminar" });
    }
  },

  // 📊 CARGA MASIVA EXCEL (JSON)
  async bulkCreate(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) =>
        DocumentosService.bulkCreate(client, tenantId, req.body)
      );
      await publicarEventoTenant(tenantId, "documentos.carga_masiva", {
        cantidad: Array.isArray(req.body) ? req.body.length : undefined,
      });
      res.status(201).json(data);
    } catch {
      res.status(500).json({ error: "Error en carga masiva" });
    }
  },

  // 📊 KPIs DASHBOARD
  async kpis(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) =>
        DocumentosService.getKPIs(client, tenantId)
      );
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error en KPIs" });
    }
  },
};
