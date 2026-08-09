/**src/modules/combutible/combustible.routes.ts */

import { Router } from "express";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { CombustibleController } from "./combustible.controller";

const router = Router();
const controller = new CombustibleController();

router.get("/", asyncHandler(controller.getAll.bind(controller)));
router.get("/:id", asyncHandler(controller.getById.bind(controller)));
router.put(
  "/:id/nivel",
  requireRole("admin", "operador"),
  asyncHandler(controller.updateNivel.bind(controller))
);

export default router;
