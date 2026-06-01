/**src/modules/combutible/combustible.routes.ts */

import { Router } from "express";
import { CombustibleController } from "./combustible.controller";

const router = Router();
const controller = new CombustibleController();

router.get("/", controller.getAll.bind(controller));
router.get("/:id", controller.getById.bind(controller));
router.put("/:id/nivel", controller.updateNivel.bind(controller));

export default router;