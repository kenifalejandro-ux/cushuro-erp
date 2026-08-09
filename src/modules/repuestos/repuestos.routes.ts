/**src/modules/repuestos/repuestos.routes.ts */

import { Router } from "express";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { RepuestosController } from "./repuestos.controller";

const router = Router();

// 📥 listar
router.get("/", asyncHandler(RepuestosController.getAll));

// ➕ crear
router.post("/", requireRole("admin", "operador"), asyncHandler(RepuestosController.create));

// ✏️ actualizar (NUEVO)
router.put("/:id", requireRole("admin", "operador"), asyncHandler(RepuestosController.update));

// 🗑 eliminar
router.delete("/:id", requireRole("admin"), asyncHandler(RepuestosController.delete));

// 📦 importación masiva
router.post("/bulk", requireRole("admin", "operador"), asyncHandler(RepuestosController.bulk));

// 📊 KPIs
router.get("/kpis/dashboard", asyncHandler(RepuestosController.kpis));

export default router;
