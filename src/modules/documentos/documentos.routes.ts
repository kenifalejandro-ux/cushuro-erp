/** src/modules/documentos/documentos.routes.ts */

import { Router } from "express";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { validate } from "../../server/middleware/validate";
import {
  crearDocumentoSchema,
  actualizarDocumentoSchema,
  cargaMasivaDocumentosSchema,
  subirVersionDocumentoSchema,
} from "../../server/schemas/documentos.schema";
import { subirArchivoDocumento } from "./documentos.upload";
import { DocumentosController } from "./documentos.controller";

const router = Router();

// 📄 CRUD
router.get("/", asyncHandler(DocumentosController.getAll));
// Va ANTES que POST / a propósito, junto al resto de rutas de lectura --
// no hay ningún GET /:id que pudiera chocar con este path literal, pero
// mantenerlo agrupado con el resto del CRUD es más legible.
router.get("/duplicado", asyncHandler(DocumentosController.verificarDuplicado));
router.post(
  "/",
  requireRole("admin", "operador"),
  validate(crearDocumentoSchema),
  asyncHandler(DocumentosController.create)
);
router.put(
  "/:id",
  requireRole("admin", "operador"),
  validate(actualizarDocumentoSchema),
  asyncHandler(DocumentosController.update)
);
router.delete("/:id", requireRole("admin"), asyncHandler(DocumentosController.delete));

// 📊 EXCEL MASIVO
// El límite de tamaño del cuerpo para esta ruta lo amplía app.ts (los 16 kb
// del default cortaban la importación a ~110 filas, ver BULK_BODY_LIMIT).
router.post(
  "/bulk",
  requireRole("admin", "operador"),
  validate(cargaMasivaDocumentosSchema),
  asyncHandler(DocumentosController.bulkCreate)
);

// 📎 ARCHIVO ADJUNTO (versionado)
router.post(
  "/:id/versiones",
  requireRole("admin", "operador"),
  subirArchivoDocumento,
  validate(subirVersionDocumentoSchema),
  asyncHandler(DocumentosController.subirVersion)
);
router.get("/:id/versiones", asyncHandler(DocumentosController.listarVersiones));
router.get(
  "/:id/versiones/:versionId/descarga",
  asyncHandler(DocumentosController.descargarVersion)
);

export default router;
