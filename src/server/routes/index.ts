/** src/server/routes/index.ts**/

import { Router } from "express";

import repuestosRoutes from "../../modules/repuestos/repuestos.routes";
import combustibleRoutes from "../../modules/combustible/combustible.routes";
import documentosRoutes from "../../modules/documentos/documentos.routes";
import dashboardRoutes from "../../modules/dashboard/dashboard.routes";
import equiposRoutes from "../../modules/equipos/equipos.routes";
import checklistsRoutes from "../../modules/checklists/checklists.routes";
import ipercRoutes from "../../modules/iperc/iperc.routes";
import { authMiddleware } from "../shared/middlewares/auth.middleware";
import { tenantMiddleware } from "../shared/middlewares/tenant.middleware";
import { requireModulo } from "../shared/middlewares/modulo.middleware";
import { tenantMetricsMiddleware } from "../shared/middlewares/tenantMetrics.middleware";

export function createApiRouter() {
  const router = Router();

  // Toda ruta de negocio del ERP exige sesión válida y queda con
  // req.tenantId listo para que cada repository filtre por tenant.
  // tenantMetricsMiddleware va después de tenantMiddleware (necesita
  // req.tenantId) y antes de requireModulo (un 403 por módulo también
  // cuenta como tráfico real — ver platformTenantHealth.service.ts).
  router.use(authMiddleware, tenantMiddleware, tenantMetricsMiddleware);

  router.use("/repuestos", requireModulo("repuestos"), repuestosRoutes);
  router.use("/combustible", requireModulo("combustible"), combustibleRoutes);
  router.use("/documentos", requireModulo("documentos"), documentosRoutes);
  router.use("/dashboard", requireModulo("dashboard"), dashboardRoutes);
  router.use("/equipos", requireModulo("equipos"), equiposRoutes);
  router.use("/checklists", requireModulo("checklists"), checklistsRoutes);
  router.use("/iperc", requireModulo("iperc"), ipercRoutes);

  return router;
}
