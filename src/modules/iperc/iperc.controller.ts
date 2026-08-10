/** src/modules/iperc/iperc.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import {
  parsePaginacion,
  armarRespuestaPaginada,
  parseCursorPaginacion,
  armarRespuestaCursor,
} from "../../server/shared/utils/pagination";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import type {
  CrearIpercInput,
  CambiarEstadoIpercInput,
  CrearLineaBaseInput,
} from "../../server/schemas/iperc.schema";
import { IpercService } from "./iperc.service";

export const IpercController = {
  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parseCursorPaginacion(req.query);
      const tipo = typeof req.query.tipo === "string" ? req.query.tipo : undefined;
      const filas = await withTenant(tenantId, (client) =>
        IpercService.getAll(client, tenantId, paginacion, tipo)
      );
      res.json(armarRespuestaCursor(filas, paginacion.pageSize));
    } catch {
      res.status(500).json({ message: "Error al obtener IPERC" });
    }
  },

  async getById(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const iperc = await withTenant(tenantId, (client) =>
        IpercService.getById(client, tenantId, Number(req.params.id))
      );
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
      const iperc = await withTenant(tenantId, (client) =>
        IpercService.crear(client, tenantId, req.usuario!.id, data)
      );
      await registrarAuditoria({
        accion: "iperc.crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { ipercId: iperc.id, tipo: data.tipo },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "iperc.creado", { ipercId: iperc.id, tipo: data.tipo });
      res.status(201).json(iperc);
    } catch (err) {
      if (err instanceof Error && err.message.includes("no existe en este tenant")) {
        res.status(400).json({ message: err.message });
        return;
      }
      res.status(500).json({ message: "Error al crear IPERC" });
    }
  },

  async cambiarEstado(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { estado } = req.validatedBody as CambiarEstadoIpercInput;
      const iperc = await withTenant(tenantId, (client) =>
        IpercService.cambiarEstado(client, tenantId, id, estado, req.usuario!.id)
      );
      if (!iperc) {
        res.status(404).json({ message: "IPERC no encontrado" });
        return;
      }
      await registrarAuditoria({
        accion: "iperc.cambiar_estado",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { ipercId: id, estado },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "iperc.estado_cambiado", { ipercId: id, estado });
      res.json(iperc);
    } catch {
      res.status(500).json({ message: "Error al cambiar estado del IPERC" });
    }
  },

  async eliminar(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const eliminado = await withTenant(tenantId, (client) =>
        IpercService.eliminar(client, tenantId, id)
      );
      if (!eliminado) {
        res.status(404).json({ message: "IPERC no encontrado" });
        return;
      }
      await registrarAuditoria({
        accion: "iperc.eliminar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { ipercId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "iperc.eliminado", { ipercId: id });
      res.json({ message: "Eliminado" });
    } catch {
      res.status(500).json({ message: "Error al eliminar IPERC" });
    }
  },

  // ── Línea Base ───────────────────────────────────────────────────────
  async getLineasBase(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        IpercService.getLineasBase(client, tenantId, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ message: "Error al obtener líneas base" });
    }
  },

  async getLineaBase(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const lineaBase = await withTenant(tenantId, (client) =>
        IpercService.getLineaBase(client, tenantId, Number(req.params.id))
      );
      if (!lineaBase) {
        res.status(404).json({ message: "Línea base no encontrada" });
        return;
      }
      res.json(lineaBase);
    } catch {
      res.status(500).json({ message: "Error al obtener línea base" });
    }
  },

  async crearLineaBase(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearLineaBaseInput;
      const lineaBase = await withTenant(tenantId, (client) =>
        IpercService.crearLineaBase(client, tenantId, req.usuario!.id, data)
      );
      await registrarAuditoria({
        accion: "iperc.crear_linea_base",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { lineaBaseId: lineaBase.id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "iperc.linea_base_creada", {
        lineaBaseId: lineaBase.id,
      });
      res.status(201).json(lineaBase);
    } catch {
      res.status(500).json({ message: "Error al crear línea base" });
    }
  },

  async cambiarEstadoLineaBase(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { estado } = req.validatedBody as CambiarEstadoIpercInput;
      const lineaBase = await withTenant(tenantId, (client) =>
        IpercService.cambiarEstadoLineaBase(client, tenantId, id, estado, req.usuario!.id)
      );
      if (!lineaBase) {
        res.status(404).json({ message: "Línea base no encontrada" });
        return;
      }
      await registrarAuditoria({
        accion: "iperc.cambiar_estado_linea_base",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { lineaBaseId: id, estado },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "iperc.linea_base_estado_cambiado", {
        lineaBaseId: id,
        estado,
      });
      res.json(lineaBase);
    } catch {
      res.status(500).json({ message: "Error al cambiar estado de la línea base" });
    }
  },

  async eliminarLineaBase(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const eliminado = await withTenant(tenantId, (client) =>
        IpercService.eliminarLineaBase(client, tenantId, id)
      );
      if (!eliminado) {
        res.status(404).json({ message: "Línea base no encontrada" });
        return;
      }
      await registrarAuditoria({
        accion: "iperc.eliminar_linea_base",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { lineaBaseId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "iperc.linea_base_eliminada", { lineaBaseId: id });
      res.json({ message: "Eliminada" });
    } catch {
      res.status(500).json({ message: "Error al eliminar línea base" });
    }
  },
};
