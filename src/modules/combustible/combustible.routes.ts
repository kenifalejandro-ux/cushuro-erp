/**src/modules/combutible/combustible.routes.ts */

import { Router } from "express";
import { validate } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import {
  registrarLecturaCombustibleSchema,
  actualizarNivelCombustibleSchema,
} from "../../server/schemas/combustible.schema";
import { CombustibleController } from "./combustible.controller";

const router = Router();
const controller = new CombustibleController();

router.get("/", asyncHandler(controller.getAll.bind(controller)));
router.get("/:id", asyncHandler(controller.getById.bind(controller)));

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
