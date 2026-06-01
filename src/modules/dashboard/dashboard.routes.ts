/** src/modules/dashboard/dashboard.routes.ts */

import { Router } from "express";
import { DashboardController } from "./dashboard.controller";

const router = Router();

/**
 * Esta es la ruta que llama tu Dashboard.tsx mediante:
 * fetch('http://localhost:3000/api/erp/dashboard')
 */
router.get("/", DashboardController.getFullDashboard);

// Rutas individuales por si necesitas recargar un gráfico específico
router.get("/kpis", DashboardController.getKPIs);
router.get("/repuestos-categoria", DashboardController.repuestosPorCategoria);
router.get("/valor-categoria", DashboardController.valorPorCategoria);
router.get("/documentos", DashboardController.estadoDocumentos);
// 🔥 AGREGAMOS ESTE: Para el gráfico de stock comparativo
router.get("/stock-nivel", DashboardController.nivelstock); 

export default router;
