/** src/modules/documentos/documentos.routes.ts */

import { Router } from "express";
import { DocumentosController } from "./documentos.controller";

const router = Router();

// 📄 CRUD
router.get("/", DocumentosController.getAll);
router.post("/", DocumentosController.create);
router.put("/:id", DocumentosController.update);
router.delete("/:id", DocumentosController.delete);

// 📊 EXCEL MASIVO
router.post("/bulk", DocumentosController.bulkCreate);

export default router;