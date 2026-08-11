/** src/modules/documentos/documentos.routes.ts */

import { Router } from "express";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { subirArchivoDocumento } from "./documentos.upload";
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

// 📎 ARCHIVO ADJUNTO (versionado)
router.post(
  "/:id/versiones",
  requireRole("admin", "operador"),
  subirArchivoDocumento,
  asyncHandler(DocumentosController.subirVersion)
);
router.get("/:id/versiones", asyncHandler(DocumentosController.listarVersiones));
router.get(
  "/:id/versiones/:versionId/descarga",
  asyncHandler(DocumentosController.descargarVersion)
);

export default router;
