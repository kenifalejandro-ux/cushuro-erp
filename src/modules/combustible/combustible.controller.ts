/**src/modules/combutible/combustible.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import type {
  RegistrarLecturaCombustibleInput,
  ActualizarNivelCombustibleInput,
} from "../../server/schemas/combustible.schema";
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

  /** Legacy: mismo contrato de siempre (body `{ nivel_actual }`, responde el
   *  tanque). Ya no sobreescribe `nivel_actual` directo por dentro -- ver
   *  `CombustibleService.actualizarNivelLegacy`. */
  async updateNivel(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { nivel_actual } = req.validatedBody as ActualizarNivelCombustibleInput;

      const updated = await withTenant(tenantId, (client) =>
        service.actualizarNivelLegacy(client, tenantId, req.usuario!.id, id, nivel_actual)
      );

      if (!updated) {
        return res.status(404).json({ error: "No encontrado" });
      }

      await registrarAuditoria({
        accion: "combustible.actualizar_nivel",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { combustibleId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.nivel_actualizado", {
        combustibleId: id,
        nivelActual: nivel_actual,
      });
      res.json(updated);
    } catch (err) {
      // El tanque no existe en este tenant -- mismo motivo que el 404 de
      // siempre (`updated` null), solo que acá llega como excepción porque
      // registrarLectura() valida la FK antes de insertar. Se preserva el
      // 404 histórico de este endpoint, NO el 400 del endpoint nuevo (ver
      // registrarLectura más abajo) -- no romper el contrato existente.
      if (err instanceof Error && err.message.includes("no existe en este tenant")) {
        res.status(404).json({ error: "No encontrado" });
        return;
      }
      res.status(500).json({ error: "Error al actualizar nivel" });
    }
  }

  /** POST /combustible/lecturas -- crea una lectura histórica y, si es la
   *  más reciente, actualiza `nivel_actual` (ver
   *  CombustibleRepository.registrarLectura). Único endpoint de Combustible
   *  que participa de la cola offline: `combustible_id` viaja en el body a
   *  propósito, no en la URL -- el motor offline del cliente
   *  (rutasOffline.ts) solo matchea rutas literales, sin parámetros. */
  async registrarLectura(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as RegistrarLecturaCombustibleInput;
      const { fila, creado } = await withTenant(tenantId, (client) =>
        service.registrarLectura(client, tenantId, req.usuario!.id, data)
      );

      // Reintento de un envío que ya se había guardado (la respuesta
      // original se perdió en la red). No se publica el evento de nuevo --
      // eso ya pasó la primera vez. 200 y no 201 porque esta llamada no
      // creó nada, pero sí es un éxito para la cola offline del dispositivo.
      if (!creado) {
        res.status(200).json(fila ?? { error: "Esta lectura ya se había registrado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.registrar_lectura",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { lecturaId: fila!.lectura.id, combustibleId: data.combustible_id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.lectura_registrada", {
        lecturaId: fila!.lectura.id,
        combustibleId: data.combustible_id,
        nivel: data.nivel,
      });
      res.status(201).json(fila);
    } catch (err) {
      if (err instanceof Error && err.message.includes("no existe en este tenant")) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al registrar lectura de combustible" });
    }
  }
}
