/** src/server/shared/middlewares/tenantMetrics.middleware.ts
 *
 * Cuenta requests/errores/latencia/creaciones por tenant, agregado por
 * hora (ver platformTenantHealth.service.ts) — alimenta "salud del
 * tenant" en el panel de plataforma. Va DESPUÉS de tenantMiddleware en
 * createApiRouter (necesita req.tenantId ya resuelto) y ANTES de
 * requireModulo (así una petición bloqueada por módulo no habilitado
 * también cuenta — es tráfico real igual).
 *
 * La marca de tiempo se toma con process.hrtime.bigint() (no Date.now())
 * porque es monotónica — un ajuste del reloj del sistema durante el
 * request no puede dar una latencia negativa o inflada. Se engancha a
 * `res.on("finish")`, después de que la respuesta ya salió — nunca agrega
 * latencia al request real, y un fallo acá nunca lo tira abajo
 * (registrarMetricaRequest ya se ocupa de no lanzar).
 */
import type { Request, Response, NextFunction } from "express";
import { getTenantId } from "../utils/request";
import { registrarMetricaRequest } from "../../services/platformTenantHealth.service";

export function tenantMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const inicio = process.hrtime.bigint();
  res.on("finish", () => {
    const latenciaMs = Number(process.hrtime.bigint() - inicio) / 1_000_000;
    void registrarMetricaRequest({
      tenantId: getTenantId(req),
      statusCode: res.statusCode,
      esCreacion: req.method === "POST" && res.statusCode >= 200 && res.statusCode < 300,
      latenciaMs,
    });
  });
  next();
}
