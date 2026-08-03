/** src/server/shared/middlewares/tenantMetrics.middleware.ts
 *
 * Cuenta requests/errores/creaciones por tenant, agregado por hora (ver
 * platformTenantHealth.service.ts) — alimenta "salud del tenant" en el
 * panel de plataforma. Va DESPUÉS de tenantMiddleware en createApiRouter
 * (necesita req.tenantId ya resuelto) y ANTES de requireModulo (así una
 * petición bloqueada por módulo no habilitado también cuenta — es tráfico
 * real igual).
 *
 * Se engancha a `res.on("finish")`, después de que la respuesta ya salió
 * — nunca agrega latencia al request real, y un fallo acá nunca lo tira
 * abajo (registrarMetricaRequest ya se ocupa de no lanzar).
 */
import type { Request, Response, NextFunction } from "express";
import { getTenantId } from "../utils/request";
import { registrarMetricaRequest } from "../../services/platformTenantHealth.service";

export function tenantMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  res.on("finish", () => {
    void registrarMetricaRequest({
      tenantId: getTenantId(req),
      statusCode: res.statusCode,
      esCreacion: req.method === "POST" && res.statusCode >= 200 && res.statusCode < 300,
    });
  });
  next();
}
