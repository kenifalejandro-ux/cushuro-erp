/** src/modules/documentos/documentos.routes.ts */

import { Router } from "express";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { DocumentosController } from "./documentos.controller";

const router = Router();

// 📄 CRUD
router.get("/", asyncHandler(DocumentosController.getAll));
router.post("/", requireRole("admin", "operador"), asyncHandler(DocumentosController.create));
router.put("/:id", requireRole("admin", "operador"), asyncHandler(DocumentosController.update));
router.delete("/:id", requireRole("admin"), asyncHandler(DocumentosController.delete));

// 📊 EXCEL MASIVO
router.post(
  "/bulk",
  requireRole("admin", "operador"),
  asyncHandler(DocumentosController.bulkCreate)
);

export default router;
