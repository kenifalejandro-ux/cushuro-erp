/** src/server/shared/middlewares/modulo.middleware.ts */

import type { Request, Response, NextFunction } from "express";

/** Debe usarse siempre después de authMiddleware. Bloquea un módulo entero
 *  (repuestos, combustible, etc.) si el tenant no lo tiene contratado o si
 *  el panel de plataforma no se lo asignó a este usuario en particular —
 *  ver modulosPermitidos en UsuarioPayload (auth.service.ts). */
export function requireModulo(modulo: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const usuario = req.usuario;
    if (!usuario) {
      return res.status(401).json({ ok: false, message: "No autenticado" });
    }
    if (!usuario.modulosPermitidos.includes(modulo)) {
      return res.status(403).json({ ok: false, message: "Módulo no disponible" });
    }
    next();
  };
}
