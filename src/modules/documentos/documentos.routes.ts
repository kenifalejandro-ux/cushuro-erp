/** src/modules/documentos/documentos.routes.ts */

import { Router } from "express";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { DocumentosController } from "./documentos.controller";

const router = Router();

// 📄 CRUD
router.get("/", DocumentosController.getAll);
router.post("/", requireRole("admin", "operador"), DocumentosController.create);
router.put("/:id", requireRole("admin", "operador"), DocumentosController.update);
router.delete("/:id", requireRole("admin"), DocumentosController.delete);

// 📊 EXCEL MASIVO
router.post("/bulk", requireRole("admin", "operador"), DocumentosController.bulkCreate);

export default router;
