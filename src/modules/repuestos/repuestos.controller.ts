/**src/modules/repuestos/repuestos.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import type { RegistrarMovimientoRepuestoInput } from "../../server/schemas/repuestos.schema";
import { RepuestosService } from "./repuestos.service";

export const RepuestosController = {
  // =========================
  // 📥 OBTENER TODO (paginado)
  // =========================
  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        RepuestosService.getAll(client, tenantId, paginacion)
      );
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
      const nuevo = await withTenant(tenantId, (client) =>
        RepuestosService.create(client, tenantId, req.body)
      );
      await publicarEventoTenant(tenantId, "repuestos.creado", { repuestoId: nuevo.id });
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

      const actualizado = await withTenant(tenantId, (client) =>
        RepuestosService.update(client, tenantId, id, data)
      );

      if (!actualizado) {
        res.status(404).json({ message: "Repuesto no encontrado" });
        return;
      }

      await publicarEventoTenant(tenantId, "repuestos.actualizado", { repuestoId: id });
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
      const id = Number(req.params.id);
      const eliminado = await withTenant(tenantId, (client) =>
        RepuestosService.delete(client, tenantId, id)
      );

      if (!eliminado) {
        res.status(404).json({ message: "Repuesto no encontrado" });
        return;
      }

      await publicarEventoTenant(tenantId, "repuestos.eliminado", { repuestoId: id });
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
      const result = await withTenant(tenantId, (client) =>
        RepuestosService.createBulk(client, tenantId, rows)
      );
      await publicarEventoTenant(tenantId, "repuestos.carga_masiva", { cantidad: result.length });
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
      const data = await withTenant(tenantId, (client) =>
        RepuestosService.getKPIs(client, tenantId)
      );
      res.json(data);
    } catch {
      res.status(500).json({ message: "Error KPIs" });
    }
  },

  // =========================
  // 📦 REGISTRAR MOVIMIENTO DE STOCK
  // =========================
  // POST /repuestos/movimientos -- crea un movimiento histórico y aplica su
  // delta a `stock` (ver RepuestosRepository.registrarMovimiento). Único
  // endpoint de Repuestos que participa de la cola offline: `repuesto_id`
  // viaja en el body a propósito, no en la URL -- rutasOffline.ts (motor
  // offline del cliente) solo matchea rutas literales, sin parámetros.
  async registrarMovimiento(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as RegistrarMovimientoRepuestoInput;
      const { fila, creado } = await withTenant(tenantId, (client) =>
        RepuestosService.registrarMovimiento(client, tenantId, req.usuario!.id, data)
      );

      // Reintento de un envío que ya se había guardado (la respuesta
      // original se perdió en la red). No se publica el evento de nuevo --
      // eso ya pasó la primera vez. 200 y no 201 porque esta llamada no
      // creó nada, pero sí es un éxito para la cola offline del dispositivo.
      if (!creado) {
        res.status(200).json(fila ?? { message: "Este movimiento ya se había registrado" });
        return;
      }

      await publicarEventoTenant(tenantId, "repuestos.movimiento_registrado", {
        movimientoId: fila!.movimiento.id,
        repuestoId: data.repuesto_id,
        tipo: data.tipo,
        cantidad: data.cantidad,
      });
      res.status(201).json(fila);
    } catch (err) {
      if (err instanceof Error && err.message.includes("no existe en este tenant")) {
        res.status(400).json({ message: err.message });
        return;
      }
      // 409 y no 400: no es un dato mal formado, es un rechazo por el
      // ESTADO actual del recurso -- y es la clave de todo esto: cae
      // dentro de `esErrorPermanente()` (client/src/offline/offlineSync.ts,
      // 4xx salvo 401/408/429), así que la cola offline del dispositivo lo
      // descarta sin reintentar y lo reporta -- sin tocar el motor offline
      // ni EstadoOffline.tsx, que ya son genéricos.
      if (err instanceof Error && err.message.includes("stock insuficiente")) {
        res.status(409).json({ message: err.message });
        return;
      }
      res.status(500).json({ message: "Error al registrar movimiento de repuesto" });
    }
  },
};
