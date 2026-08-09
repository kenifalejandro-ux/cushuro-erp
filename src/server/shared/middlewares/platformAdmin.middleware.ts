/** src/server/shared/middlewares/platformAdmin.middleware.ts
 *
 * Protege operaciones de plataforma (alta de tenants, control de módulos,
 * auditoría, gestión de otros Platform Admin) que no pertenecen al sistema
 * de login normal — no hay, ni debe haber, un rol "admin" que cruce
 * tenants dentro de usuarios/JWT (eso rompería el aislamiento que
 * garantizan RLS y el propio JWT).
 *
 * Acepta la credencial de tres formas, todas resueltas al mismo
 * `req.platformActor` (ver shared/utils/request.ts):
 *   - header `Authorization: Bearer <PLATFORM_ADMIN_TOKEN>` (curl,
 *     integraciones): stateless, se compara directo contra el secreto en
 *     cada request. Actor = emergency_shared_secret, sin sesión.
 *   - cookie `platform_session` = `sid.<uuid>` (UI del panel — ver
 *     POST /api/platform/sesion y POST /api/platform/admin-sesion en
 *     platform.ts): resuelve la sesión contra Redis vía
 *     platformSession.service.ts, que ya trae el actor guardado desde el
 *     login (individual o de emergencia) — revocable sin rotar el secreto
 *     para todos ni desactivar al resto de los admins.
 *   - cookie `platform_session` = token crudo (formato legado, de antes
 *     de que existiera session_id, o de un login con el secreto
 *     compartido cuando Redis no estaba disponible): se sigue aceptando
 *     para no invalidar sesiones activas. Actor = emergency_shared_secret.
 *   Nunca en `localStorage`/`sessionStorage` legible por JS: la cookie es
 *   httpOnly a propósito, dado lo que esta credencial puede tocar (todos
 *   los tenants a la vez, o incluso otras cuentas de Platform Admin).
 *
 * PLATFORM_ADMIN_TOKEN sigue aceptándose exactamente igual que antes de
 * las cuentas individuales — es el modo de emergencia, nunca se retira.
 */
import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { env } from "../../config/env";
import { getClientIp, getRequestId, getUserAgent, type PlatformActor } from "../utils/request";
import { registrarSesionRechazada } from "../../services/platformAudit.service";
import { idSesionDeCookie, obtenerSesion } from "../../services/platformSession.service";
import { asyncHandler } from "../utils/asyncHandler";

export const PLATFORM_SESSION_COOKIE = "platform_session";

function tokensCoinciden(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Buffers de distinto largo harían que timingSafeEqual lance en vez de
  // comparar — igualamos el largo primero, sin comparar contenido real.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function rechazar(req: Request, res: Response, detalleExtra: Record<string, unknown>) {
  await registrarSesionRechazada(
    {
      ip: getClientIp(req),
      requestId: getRequestId(req),
      userAgent: getUserAgent(req),
      actorType: "unauthenticated",
      actorLabel: "sin_credencial",
    },
    { path: req.path, ...detalleExtra }
  );
  return res.status(401).json({ ok: false, message: "No autorizado" });
}

function adjuntarActor(req: Request, actor: PlatformActor, sessionId?: string) {
  (req as Request & { platformActor?: PlatformActor }).platformActor = actor;
  if (sessionId) (req as Request & { platformSessionId?: string }).platformSessionId = sessionId;
}

export const platformAdminMiddleware = asyncHandler(async function platformAdminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!env.platformAdminToken) {
    return res.status(503).json({ ok: false, message: "Onboarding de tenants no configurado" });
  }

  const authHeader = req.headers.authorization;
  const tokenHeader = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : undefined;

  if (tokenHeader) {
    if (tokensCoinciden(tokenHeader, env.platformAdminToken)) {
      adjuntarActor(req, {
        actorType: "emergency_shared_secret",
        actorLabel: "secreto-compartido",
      });
      return next();
    }
    return rechazar(req, res, { via: "bearer" });
  }

  const cookieValue = (req as Request & { cookies?: Record<string, string> }).cookies?.[
    PLATFORM_SESSION_COOKIE
  ];
  if (!cookieValue) {
    return rechazar(req, res, { via: "sin_credencial" });
  }

  const sessionId = idSesionDeCookie(cookieValue);
  if (sessionId) {
    const sesion = await obtenerSesion(sessionId);
    if (!sesion) {
      return rechazar(req, res, { via: "cookie_sesion", sessionId });
    }
    adjuntarActor(req, sesion.actor, sessionId);
    return next();
  }

  // Formato legado (cookie = token crudo): sesiones creadas antes de que
  // existiera session_id, o cuando Redis no estaba disponible al hacer
  // login con el secreto compartido.
  if (tokensCoinciden(cookieValue, env.platformAdminToken)) {
    adjuntarActor(req, { actorType: "emergency_shared_secret", actorLabel: "secreto-compartido" });
    return next();
  }

  return rechazar(req, res, { via: "cookie_legado" });
});
