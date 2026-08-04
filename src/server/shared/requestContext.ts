/** src/server/shared/requestContext.ts
 *
 * AsyncLocalStorage con el propio `req` de la petición en curso. Se llena
 * una sola vez en requestContext.middleware.ts (montado justo después de
 * pino-http, así req.id ya existe) y se lee en cualquier punto del código
 * que corra dentro de esa cadena async — típicamente el logger (ver
 * mixin en config/logger.ts), sin importar si el log sale desde un
 * controller (que tiene req.log a mano) o desde un service (que no).
 *
 * Guardar el `req` en vez de copiar sus campos a un objeto aparte evita
 * tener que sincronizar el contexto en cada punto donde se resuelve
 * tenantId/usuario (tenantMiddleware, authMiddleware, resolveTenantSubdomain,
 * scim.middleware.ts, etc.) — getRequestContext() siempre lee el estado
 * más actual de esos campos en el momento del log.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";

const als = new AsyncLocalStorage<Request>();

export function runWithRequestContext<T>(req: Request, fn: () => T): T {
  return als.run(req, fn);
}

export interface RequestLogContext {
  requestId?: string;
  tenantId?: string;
  usuarioId?: string;
}

export function getRequestContext(): RequestLogContext | undefined {
  const req = als.getStore();
  if (!req) return undefined;

  return {
    requestId: typeof req.id === "string" ? req.id : undefined,
    tenantId: req.tenantId,
    usuarioId: req.usuario?.id,
  };
}
