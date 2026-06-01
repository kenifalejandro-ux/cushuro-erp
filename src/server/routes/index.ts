/** src/server/routes/index.ts**/

import { Router } from "express";

import repuestosRoutes from "../../modules/repuestos/repuestos.routes";
import combustibleRoutes from "../../modules/combustible/combustible.routes";
import documentosRoutes from "../../modules/documentos/documentos.routes";
import dashboardRoutes from "../../modules/dashboard/dashboard.routes";

export function createApiRouter() {
  const router = Router();

  router.use("/repuestos", repuestosRoutes);
  router.use("/combustible", combustibleRoutes);
  router.use("/documentos", documentosRoutes);
  router.use("/dashboard", dashboardRoutes);

  return router;
}