import type { Request } from "express";

export function getClientIp(req: Request) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const forwardedIp = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(",")[0];

  return req.ip || forwardedIp?.trim() || req.socket.remoteAddress || "unknown";
}

/** Siempre leer el tenant del request (adjuntado por tenantMiddleware desde
 *  el JWT verificado), nunca de body/query — esos los controla el cliente. */
export function getTenantId(req: Request): string {
  const tenantId = (req as Request & { tenantId?: string }).tenantId;
  if (!tenantId) {
    throw new Error("tenantId no presente en el request: falta tenantMiddleware en esta ruta");
  }
  return tenantId;
}

export function getUserAgent(req: Request): string | undefined {
  const value = req.headers["user-agent"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Sesión de plataforma resuelta por platformAdminMiddleware (cookie
 *  `sid.<uuid>` validada contra Redis) — undefined en login por header
 *  `Authorization: Bearer`, que es stateless y no tiene sesión. */
export function getPlatformSessionId(req: Request): string | undefined {
  return (req as Request & { platformSessionId?: string }).platformSessionId;
}

/** Quién está autenticado en este request de plataforma — adjuntado por
 *  platformAdminMiddleware tras validar el header Bearer o la cookie de
 *  sesión. Nunca "unauthenticated" acá: si la autenticación falló, el
 *  middleware ya cortó el request con 401 antes de llegar a ningún handler
 *  que llame a esto (ver platformAudit.service.ts para el caso rechazado). */
export type PlatformActor =
  | { actorType: "platform_admin"; actorId: string; actorLabel: string }
  | { actorType: "emergency_shared_secret"; actorLabel: string };

export function getPlatformActor(req: Request): PlatformActor | undefined {
  return (req as Request & { platformActor?: PlatformActor }).platformActor;
}

export function getRequestId(req: Request) {
  const requestWithId = req as Request & { id?: string };
  if (typeof requestWithId.id === "string" && requestWithId.id.length > 0) {
    return requestWithId.id;
  }

  const headerValue = req.headers["x-request-id"];
  if (typeof headerValue === "string" && headerValue.length > 0) {
    return headerValue;
  }

  if (Array.isArray(headerValue) && typeof headerValue[0] === "string") {
    return headerValue[0];
  }

  return undefined;
}
