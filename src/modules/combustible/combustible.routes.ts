/**src/modules/combutible/combustible.routes.ts */

import { Router } from "express";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { CombustibleController } from "./combustible.controller";

const router = Router();
const controller = new CombustibleController();

router.get("/", controller.getAll.bind(controller));
router.get("/:id", controller.getById.bind(controller));
router.put("/:id/nivel", requireRole("admin", "operador"), controller.updateNivel.bind(controller));

export default router;
