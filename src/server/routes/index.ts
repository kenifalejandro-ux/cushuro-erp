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

export function createApiRouter() {
  const router = Router();

  // Toda ruta de negocio del ERP exige sesión válida y queda con
  // req.tenantId listo para que cada repository filtre por tenant.
  router.use(authMiddleware, tenantMiddleware);

  router.use("/repuestos", repuestosRoutes);
  router.use("/combustible", combustibleRoutes);
  router.use("/documentos", documentosRoutes);
  router.use("/dashboard", dashboardRoutes);
  router.use("/equipos", equiposRoutes);
  router.use("/checklists", checklistsRoutes);
  router.use("/iperc", ipercRoutes);

  return router;
}
