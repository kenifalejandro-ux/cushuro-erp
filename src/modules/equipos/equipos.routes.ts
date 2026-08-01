/** src/modules/equipos/equipos.routes.ts */

import { Router } from "express";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { EquiposController } from "./equipos.controller";

const router = Router();

router.get("/", EquiposController.getAll);
router.post("/", requireRole("admin", "operador"), EquiposController.create);
router.put("/:id", requireRole("admin", "operador"), EquiposController.update);
router.delete("/:id", requireRole("admin"), EquiposController.delete);

export default router;
