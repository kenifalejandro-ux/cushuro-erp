/** src/server/shared/middlewares/platformSuperAdmin.middleware.ts
 *
 * Gate adicional sobre platformAdminMiddleware, solo para las rutas de
 * gestión de otras cuentas de Platform Admin (GET/POST /admins, PATCH
 * /admins/:id/estado) — crear o desactivar admins es más sensible que el
 * resto de las acciones de plataforma, así que además de estar
 * autenticado hay que ser super_admin (o el secreto compartido, que sigue
 * siendo el fallback de emergencia con más poder que cualquier cuenta
 * individual — así se puede recuperar acceso si todos los super_admin
 * quedan bloqueados).
 *
 * No confía en nada cacheado en la sesión de Redis: esSuperAdminVigente()
 * revalida rol/activo contra la base en cada request, porque este es un
 * gate de privilegio, no una acción cualquiera — un admin degradado a rol
 * "admin" no debe poder seguir gestionando otros admins hasta que su
 * sesión expire sola.
 */
import type { Request, Response, NextFunction } from "express";
import { getPlatformActor } from "../utils/request";
import { esSuperAdminVigente } from "../../services/platformAdminAccount.service";

export async function platformSuperAdminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (await esSuperAdminVigente(getPlatformActor(req))) return next();
  return res
    .status(403)
    .json({ ok: false, message: "Requiere permisos de super-admin de plataforma" });
}
