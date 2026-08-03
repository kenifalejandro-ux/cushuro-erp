/** src/server/middleware/platformAdminLoginRateLimiter.ts
 *
 * Límite específico para POST /api/platform/admin-sesion — separado del
 * rateLimiter genérico (que comparte ventana con cualquier formulario de
 * la app) porque acá el riesgo es adivinar la contraseña de un admin, no
 * solo abuso de formulario: subir el límite genérico para otro form no
 * debe aflojar sin querer la protección contra fuerza bruta acá, ni al
 * revés (ver middleware/redisRateLimiter.ts para el mecanismo compartido
 * con platformTenantRateLimiter.ts).
 */
import { env } from "../config/env";
import { crearLimitadorPorIp } from "./redisRateLimiter";

export default crearLimitadorPorIp({
  prefijoClave: "platform-admin-login",
  windowMs: env.platformAdminLoginWindowMs,
  maxRequests: env.platformAdminLoginMaxRequests,
  mensaje: "Demasiados intentos de inicio de sesión. Esperá un momento antes de volver a intentar.",
});
