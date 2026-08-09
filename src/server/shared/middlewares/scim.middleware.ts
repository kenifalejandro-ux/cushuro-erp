/** src/server/shared/middlewares/scim.middleware.ts
 *
 * Autenticación de /scim/v2/* — un bearer token por tenant (ver
 * platformScim.service.ts), sin relación con el login normal ni con el
 * panel de plataforma: quien llama acá es el IdP del tenant (Okta, Azure
 * AD, etc.), nunca un browser. No hay Host que resolver: el token ES la
 * identidad del tenant.
 *
 * Los errores usan el formato de error de SCIM (RFC 7644 §3.12), no el
 * `{ ok: false, message }` del resto de la app — un cliente SCIM real
 * espera ese schema específico.
 */
import type { Request, Response, NextFunction } from "express";
import { resolverTenantPorTokenScimService } from "../../services/platformScim.service";
import { asyncHandler } from "../utils/asyncHandler";

const SCIM_ERROR_SCHEMA = ["urn:ietf:params:scim:api:messages:2.0:Error"];

function errorScim(res: Response, status: number, detail: string) {
  return res.status(status).json({ schemas: SCIM_ERROR_SCHEMA, status: String(status), detail });
}

export const scimAuthMiddleware = asyncHandler(async function scimAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;

  if (!token) {
    return errorScim(res, 401, "Falta el bearer token");
  }

  const tenantId = await resolverTenantPorTokenScimService(token);
  if (!tenantId) {
    return errorScim(res, 401, "Token inválido");
  }

  (req as Request & { scimTenantId?: string }).scimTenantId = tenantId;
  next();
});

export function getScimTenantId(req: Request): string {
  const tenantId = (req as Request & { scimTenantId?: string }).scimTenantId;
  if (!tenantId) {
    throw new Error(
      "scimTenantId no presente en el request: falta scimAuthMiddleware en esta ruta"
    );
  }
  return tenantId;
}
