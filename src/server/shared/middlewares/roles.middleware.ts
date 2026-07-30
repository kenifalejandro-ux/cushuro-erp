/** src/server/shared/middlewares/roles.middleware.ts */

import type { Request, Response, NextFunction } from "express";
import type { UsuarioPayload } from "../../services/auth.service";

/** Debe usarse siempre después de authMiddleware. */
export function requireRole(...rolesPermitidos: UsuarioPayload["rol"][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const usuario = req.usuario;
    if (!usuario) {
      return res.status(401).json({ ok: false, message: "No autenticado" });
    }
    if (!rolesPermitidos.includes(usuario.rol)) {
      return res.status(403).json({ ok: false, message: "No tienes permiso para esta acción" });
    }
    next();
  };
}
