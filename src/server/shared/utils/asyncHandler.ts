/** src/server/shared/utils/asyncHandler.ts
 *
 * Express 4 no reenvía el rechazo de un handler async a next()/al error
 * middleware -- solo lo hace con excepciones síncronas. Sin este wrapper,
 * un handler async que no tiene su propio try/catch deja el request
 * colgado sin respuesta ante cualquier error (Sentry lo ve como
 * unhandledRejection, pero el cliente nunca recibe nada). Envolver acá es
 * más chico y mecánico que agregar try/catch a cada handler.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
