/** src/server/routes/index.ts**/

import { Router } from "express";

import { MODULOS } from "../../modules/registry";
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

  // Cada módulo se monta bajo /<id> — agregar un módulo nuevo es agregarlo
  // al registry (ver docs/adr/0002-contrato-de-modulo.md), no tocar este
  // archivo.
  for (const modulo of MODULOS) {
    router.use(`/${modulo.id}`, requireModulo(modulo.id), modulo.router);
  }

  return router;
}
