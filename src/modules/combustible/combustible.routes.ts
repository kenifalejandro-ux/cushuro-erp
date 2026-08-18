/**src/modules/combutible/combustible.routes.ts */

import { Router } from "express";
import { validate } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import {
  registrarLecturaCombustibleSchema,
  actualizarNivelCombustibleSchema,
  crearTanqueCombustibleSchema,
  actualizarTanqueCombustibleSchema,
  cargaMasivaTanquesCombustibleSchema,
} from "../../server/schemas/combustible.schema";
import { CombustibleController } from "./combustible.controller";

const router = Router();
const controller = new CombustibleController();

router.get("/", asyncHandler(controller.getAll.bind(controller)));
router.get("/:id", asyncHandler(controller.getById.bind(controller)));
router.get("/:id/lecturas", asyncHandler(controller.getLecturas.bind(controller)));

// ➕ crear tanque -- admin únicamente: dar de alta un punto de
// abastecimiento es configuración de planta, no trabajo de campo (mismo
// criterio que las plantillas de Checklists, no las OT/movimientos).
router.post(
  "/",
  requireRole("admin"),
  validate(crearTanqueCombustibleSchema),
  asyncHandler(controller.create.bind(controller))
);

// ✏️ actualizar tanque
router.put(
  "/:id",
  requireRole("admin"),
  validate(actualizarTanqueCombustibleSchema),
  asyncHandler(controller.update.bind(controller))
);

// 🗑 soft-delete -- ver CombustibleController.delete
router.delete("/:id", requireRole("admin"), asyncHandler(controller.delete.bind(controller)));

// 📦 importación masiva -- el límite de tamaño del cuerpo ya lo amplía
// app.ts de forma genérica para cualquier ruta que termine en /bulk.
router.post(
  "/bulk",
  requireRole("admin"),
  validate(cargaMasivaTanquesCombustibleSchema),
  asyncHandler(controller.bulk.bind(controller))
);

// Ruta literal, sin `:id` -- el combustible_id viaja en el body a propósito
// (ver el comentario en el controller). Definida antes de /:id/nivel por
// legibilidad; no hay ambigüedad real porque los métodos HTTP son distintos.
router.post(
  "/lecturas",
  requireRole("admin", "operador"),
  validate(registrarLecturaCombustibleSchema),
  asyncHandler(controller.registrarLectura.bind(controller))
);

router.put(
  "/:id/nivel",
  requireRole("admin", "operador"),
  validate(actualizarNivelCombustibleSchema),
  asyncHandler(controller.updateNivel.bind(controller))
);

export default router;
