/**src/modules/repuestos/repuestos.routes.ts */

import { Router } from "express";
import { validate } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { registrarMovimientoRepuestoSchema } from "../../server/schemas/repuestos.schema";
import { RepuestosController } from "./repuestos.controller";

const router = Router();

// 📥 listar
router.get("/", asyncHandler(RepuestosController.getAll));

// ➕ crear
router.post("/", requireRole("admin", "operador"), asyncHandler(RepuestosController.create));

// ✏️ actualizar (NUEVO)
router.put("/:id", requireRole("admin", "operador"), asyncHandler(RepuestosController.update));

// 🗑 eliminar
router.delete("/:id", requireRole("admin"), asyncHandler(RepuestosController.delete));

// 📦 importación masiva
router.post("/bulk", requireRole("admin", "operador"), asyncHandler(RepuestosController.bulk));

// 📦 registrar movimiento de stock (entrada/salida) -- ruta literal, sin
// `:id`: el repuesto_id viaja en el body a propósito (ver el comentario en
// el controller). Único endpoint de Repuestos que participa de la cola
// offline.
router.post(
  "/movimientos",
  requireRole("admin", "operador"),
  validate(registrarMovimientoRepuestoSchema),
  asyncHandler(RepuestosController.registrarMovimiento)
);

// 📊 KPIs
router.get("/kpis/dashboard", asyncHandler(RepuestosController.kpis));

export default router;
