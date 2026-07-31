/** src/server/shared/middlewares/platformAdmin.middleware.ts
 *
 * Protege operaciones de plataforma (hoy: alta de tenants nuevos) que no
 * pertenecen al sistema de login normal — no hay, ni debe haber, un rol
 * "admin" que cruce tenants dentro de usuarios/JWT (eso rompería el
 * aislamiento que garantizan RLS y el propio JWT). En cambio, esto lo
 * protege un secreto de plataforma que solo el dueño del ERP conoce.
 */
import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { env } from "../../config/env";

function tokensCoinciden(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Buffers de distinto largo harían que timingSafeEqual lance en vez de
  // comparar — igualamos el largo primero, sin comparar contenido real.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function platformAdminMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!env.platformAdminToken) {
    return res.status(503).json({ ok: false, message: "Onboarding de tenants no configurado" });
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;

  if (!token || !tokensCoinciden(token, env.platformAdminToken)) {
    return res.status(401).json({ ok: false, message: "No autorizado" });
  }

  next();
}
