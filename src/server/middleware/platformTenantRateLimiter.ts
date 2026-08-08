/** src/server/middleware/platformTenantRateLimiter.ts
 *
 * Límite específico para POST /api/platform/tenants — crear un tenant
 * tiene mucho más blast radius que un formulario cualquiera, así que
 * necesita su propia ventana, independiente del rateLimiter genérico (ver
 * middleware/redisRateLimiter.ts para el mecanismo compartido).
 */
import { env } from "../config/env";
import { crearLimitadorPorIp } from "./redisRateLimiter";

export default crearLimitadorPorIp({
  prefijoClave: "platform-tenant-creation",
  windowMs: env.platformTenantCreationWindowMs,
  maxRequests: env.platformTenantCreationMaxRequests,
  mensaje:
    "Demasiadas empresas creadas en poco tiempo. Esperá un momento antes de volver a intentar.",
});
