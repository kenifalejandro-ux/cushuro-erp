/** src/server/shared/middlewares/error.middleware.ts */

import type { ErrorRequestHandler } from "express";
import { getRequestId } from "../utils/request";

/** Error de negocio con status HTTP explícito — úsalo en services/controllers
 *  en vez de `throw new Error(...)` cuando el caso amerita un código
 *  distinto de 500 (404 no encontrado, 409 conflicto, 422 validación, etc).
 *
 *    throw new AppError(404, "Repuesto no encontrado");
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const requestId = getRequestId(req);
  const statusCode = error instanceof AppError ? error.statusCode : 500;
  const message = error instanceof AppError ? error.message : "Error interno del servidor.";

  if (req.log) {
    if (statusCode >= 500) {
      req.log.error({ err: error, requestId }, "Error no controlado en la API");
    } else {
      req.log.warn({ err: error, requestId }, "Error de negocio en la API");
    }
  } else {
    console.error("Error en la API", error);
  }

  if (res.headersSent) return;

  res.status(statusCode).json({
    ok: false,
    message,
    requestId,
    ...(error instanceof AppError && error.details ? { details: error.details } : {}),
  });
};
