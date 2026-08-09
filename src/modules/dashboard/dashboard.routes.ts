/** src/modules/dashboard/dashboard.routes.ts */

import { Router } from "express";
import { asyncHandler } from "../../server/shared/utils/asyncHandler";
import { DashboardController } from "./dashboard.controller";

const router = Router();

/**
 * Esta es la ruta que llama tu Dashboard.tsx mediante:
 * fetch('http://localhost:3000/api/erp/dashboard')
 */
router.get("/", asyncHandler(DashboardController.getFullDashboard));

// Rutas individuales por si necesitas recargar un gráfico específico
router.get("/kpis", asyncHandler(DashboardController.getKPIs));
router.get("/repuestos-categoria", asyncHandler(DashboardController.repuestosPorCategoria));
router.get("/valor-categoria", asyncHandler(DashboardController.valorPorCategoria));
router.get("/documentos", asyncHandler(DashboardController.estadoDocumentos));
// 🔥 AGREGAMOS ESTE: Para el gráfico de stock comparativo
router.get("/stock-nivel", asyncHandler(DashboardController.nivelstock));

export default router;
