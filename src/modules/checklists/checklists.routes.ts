/** src/modules/checklists/checklists.routes.ts */

import { Router } from "express";
import { validate } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { crearPlantillaSchema, crearChecklistSchema } from "../../server/schemas/checklists.schema";
import { ChecklistsController } from "./checklists.controller";

const router = Router();

// Plantillas
router.get("/plantillas", ChecklistsController.getPlantillas);
router.get("/plantillas/:id", ChecklistsController.getPlantilla);
router.post(
  "/plantillas",
  requireRole("admin", "operador"),
  validate(crearPlantillaSchema),
  ChecklistsController.crearPlantilla
);
router.delete("/plantillas/:id", requireRole("admin"), ChecklistsController.eliminarPlantilla);

// Checklists llenados
router.get("/", ChecklistsController.getAll);
router.get("/:id", ChecklistsController.getById);
router.post("/", requireRole("admin", "operador"), validate(crearChecklistSchema), ChecklistsController.crear);
router.delete("/:id", requireRole("admin"), ChecklistsController.eliminar);

export default router;
