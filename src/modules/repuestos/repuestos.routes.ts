/**src/modules/repuestos/repuestos.routes.ts */

import { Router } from "express";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { RepuestosController } from "./repuestos.controller";

const router = Router();

// 📥 listar
router.get("/", RepuestosController.getAll);

// ➕ crear
router.post("/", requireRole("admin", "operador"), RepuestosController.create);

// ✏️ actualizar (NUEVO)
router.put("/:id", requireRole("admin", "operador"), RepuestosController.update);

// 🗑 eliminar
router.delete("/:id", requireRole("admin"), RepuestosController.delete);

// 📦 importación masiva
router.post("/bulk", requireRole("admin", "operador"), RepuestosController.bulk);

// 📊 KPIs
router.get("/kpis/dashboard", RepuestosController.kpis);

export default router;
