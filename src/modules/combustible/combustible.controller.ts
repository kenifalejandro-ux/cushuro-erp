/**src/modules/combutible/combustible.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import type {
  RegistrarLecturaCombustibleInput,
  ActualizarNivelCombustibleInput,
  CrearTanqueCombustibleInput,
  ActualizarTanqueCombustibleInput,
  CargaMasivaTanquesCombustibleInput,
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

  async create(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearTanqueCombustibleInput;
      const nuevo = await withTenant(tenantId, (client) => service.create(client, tenantId, data));
      await registrarAuditoria({
        accion: "combustible.tanque_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { combustibleId: nuevo.id, codigo: nuevo.codigo },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.tanque_creado", {
        combustibleId: nuevo.id,
      });
      res.status(201).json(nuevo);
    } catch {
      res.status(500).json({ error: "Error al crear el tanque" });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = req.validatedBody as ActualizarTanqueCombustibleInput;
      const actualizado = await withTenant(tenantId, (client) =>
        service.update(client, tenantId, id, data)
      );

      if (!actualizado) {
        return res.status(404).json({ error: "No encontrado" });
      }

      await registrarAuditoria({
        accion: "combustible.tanque_actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { combustibleId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.tanque_actualizado", {
        combustibleId: id,
      });
      res.json(actualizado);
    } catch {
      res.status(500).json({ error: "Error al actualizar el tanque" });
    }
  }

  /** Soft-delete exclusivamente -- ver CombustibleRepository.softDelete: un
   *  DELETE real borraría en cascada el historial de combustible_lecturas. */
  async delete(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const desactivado = await withTenant(tenantId, (client) =>
        service.softDelete(client, tenantId, id)
      );

      if (!desactivado) {
        return res.status(404).json({ error: "No encontrado" });
      }

      await registrarAuditoria({
        accion: "combustible.tanque_eliminar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { combustibleId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.tanque_eliminado", {
        combustibleId: id,
      });
      res.json({ message: "Tanque desactivado" });
    } catch {
      res.status(500).json({ error: "Error al desactivar el tanque" });
    }
  }

  async bulk(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const rows = req.validatedBody as CargaMasivaTanquesCombustibleInput;
      const result = await withTenant(tenantId, (client) =>
        service.createBulk(client, tenantId, rows)
      );
      // UNA fila de auditoría con el conteo, no una por tanque -- mismo
      // criterio que repuestos.carga_masiva (RepuestosController.bulk).
      await registrarAuditoria({
        accion: "combustible.tanques_carga_masiva",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { cantidad: result.length },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.tanques_carga_masiva", {
        cantidad: result.length,
      });
      res.status(201).json({ insertados: result.length, data: result });
    } catch {
      res.status(500).json({ error: "Error en importación masiva" });
    }
  }

  /** GET /:id/lecturas -- el histórico de aforos del tanque, que hasta acá
   *  era dato muerto (se guardaba en cada lectura pero no había forma de
   *  consultarlo salvo entrar a la base directo). */
  async getLecturas(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);

      const tanque = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));
      if (!tanque) {
        return res.status(404).json({ error: "No encontrado" });
      }

      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        service.getLecturas(client, tenantId, id, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al obtener el histórico de lecturas" });
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
