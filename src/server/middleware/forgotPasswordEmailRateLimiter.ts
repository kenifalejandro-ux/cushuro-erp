/** src/server/middleware/forgotPasswordEmailRateLimiter.ts
 *
 * Mismo criterio que loginEmailRateLimiter.ts, para POST
 * /api/auth/forgot-password: por tenantSlug+email, no por IP, para que
 * repartir la solicitud entre varias IPs no esquive el límite. Contador
 * separado del de login (prefijoClave distinto) -- fallar el login de una
 * cuenta no debe gastarle presupuesto a un pedido legítimo de
 * recuperación de esa misma cuenta, y viceversa.
 *
 * Debe montarse DESPUÉS de validate(forgotPasswordSchema).
 */
import type { Request } from "express";
import { env } from "../config/env";
import { crearLimitador } from "./redisRateLimiter";
import type { ForgotPasswordInput } from "../schemas/auth.schema";

export default crearLimitador({
  prefijoClave: "forgot-password-email",
  windowMs: env.forgotPasswordEmailRateLimitWindowMs,
  maxRequests: env.forgotPasswordEmailRateLimitMaxRequests,
  mensaje: "Demasiadas solicitudes para este correo. Esperá un momento antes de volver a intentar.",
  extraerClave: (req: Request) => {
    const body = req.validatedBody as ForgotPasswordInput | undefined;
    if (!body?.tenantSlug || !body?.email) return undefined;
    return `${body.tenantSlug}:${body.email}`;
  },
});
