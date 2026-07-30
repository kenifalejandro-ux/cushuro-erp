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
