/** src/modules/equipos/equipos.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import type { CrearEquipoInput, ActualizarEquipoInput } from "../../server/schemas/equipos.schema";
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
      const data = req.validatedBody as CrearEquipoInput;
      const { fila: nuevo, creado } = await withTenant(tenantId, (client) =>
        EquiposService.create(client, tenantId, data)
      );

      // Reintento de un envío que ya se había guardado (la respuesta
      // original se perdió en la red). No se audita ni se publica el
      // evento de nuevo -- eso ya pasó la primera vez. 200 y no 201 porque
      // esta llamada no creó nada, pero sigue siendo 2xx a propósito: la
      // cola offline del dispositivo puede darlo por sincronizado.
      if (!creado) {
        res
          .status(200)
          .json(nuevo ?? { message: "Este equipo ya se había registrado y luego se eliminó" });
        return;
      }

      await registrarAuditoria({
        accion: "equipos.crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { equipoId: nuevo!.id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "equipos.creado", { equipoId: nuevo!.id });
      res.status(201).json(nuevo);
    } catch {
      res.status(500).json({ message: "Error al crear equipo" });
    }
  },

  async update(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = req.validatedBody as ActualizarEquipoInput;
      const actualizado = await withTenant(tenantId, (client) =>
        EquiposService.update(client, tenantId, id, data)
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
      await publicarEventoTenant(tenantId, "equipos.actualizado", { equipoId: id });
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
      await publicarEventoTenant(tenantId, "equipos.eliminado", { equipoId: id });
      res.json({ message: "Eliminado" });
    } catch {
      res.status(500).json({ message: "Error al eliminar equipo" });
    }
  },
};
