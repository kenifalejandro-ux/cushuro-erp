/** src/server/shared/middlewares/tenant.middleware.ts */

import type { Request, Response, NextFunction } from "express";

/** Debe usarse siempre después de authMiddleware.
 *  Adjunta req.tenantId a partir del usuario ya verificado por el JWT —
 *  nunca se acepta un tenantId que venga del body/query/header del cliente,
 *  porque eso permitiría a un usuario pedir datos de otro tenant con solo
 *  cambiar un parámetro. */
export function tenantMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.usuario) {
    return res.status(401).json({ ok: false, message: "No autenticado" });
  }
  req.tenantId = req.usuario.tenantId;
  next();
}
