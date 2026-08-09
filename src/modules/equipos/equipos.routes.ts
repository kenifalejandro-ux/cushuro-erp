/** src/modules/equipos/equipos.routes.ts */

import { Router } from "express";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { EquiposController } from "./equipos.controller";

const router = Router();

router.get("/", asyncHandler(EquiposController.getAll));
router.post("/", requireRole("admin", "operador"), asyncHandler(EquiposController.create));
router.put("/:id", requireRole("admin", "operador"), asyncHandler(EquiposController.update));
router.delete("/:id", requireRole("admin"), asyncHandler(EquiposController.delete));

export default router;
