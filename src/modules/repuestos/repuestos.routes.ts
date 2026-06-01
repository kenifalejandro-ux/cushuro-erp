/**src/modules/repuestos/repuestos.routes.ts */

import { Router } from "express";
import { RepuestosController } from "./repuestos.controller";

const router = Router();

// 📥 listar
router.get("/", RepuestosController.getAll);

// ➕ crear
router.post("/", RepuestosController.create);

// ✏️ actualizar (NUEVO)
router.put("/:id", RepuestosController.update);

// 🗑 eliminar
router.delete("/:id", RepuestosController.delete);

// 📦 importación masiva
router.post("/bulk", RepuestosController.bulk);

// 📊 KPIs
router.get("/kpis/dashboard", RepuestosController.kpis);

export default router;