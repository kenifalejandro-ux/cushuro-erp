/**src/modules/repuestos/repuestos.routes.ts */

import { Router } from "express";
import { validate } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import {
  registrarMovimientoRepuestoSchema,
  crearRepuestoSchema,
  actualizarRepuestoSchema,
  cargaMasivaRepuestosSchema,
} from "../../server/schemas/repuestos.schema";
import { RepuestosController } from "./repuestos.controller";

const router = Router();

// 📥 listar
router.get("/", asyncHandler(RepuestosController.getAll));

// ➕ crear
router.post(
  "/",
  requireRole("admin", "operador"),
  validate(crearRepuestoSchema),
  asyncHandler(RepuestosController.create)
);

// ✏️ actualizar
router.put(
  "/:id",
  requireRole("admin", "operador"),
  validate(actualizarRepuestoSchema),
  asyncHandler(RepuestosController.update)
);

// 🗑 eliminar
router.delete("/:id", requireRole("admin"), asyncHandler(RepuestosController.delete));

// 📦 importación masiva -- el límite de tamaño del cuerpo para esta ruta ya
// lo amplía app.ts de forma genérica (esRutaDeCargaMasiva() matchea
// cualquier ruta que termine en /bulk), no hace falta tocar nada ahí.
router.post(
  "/bulk",
  requireRole("admin", "operador"),
  validate(cargaMasivaRepuestosSchema),
  asyncHandler(RepuestosController.bulk)
);

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
