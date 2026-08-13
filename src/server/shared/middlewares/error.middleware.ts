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

/** body-parser (el `express.json()` de app.ts) rechaza un cuerpo inválido o
 *  demasiado grande lanzando un error con `status`/`statusCode` y un `type`
 *  propios -- no un AppError. Sin esta traducción caían todos al 500
 *  genérico de abajo, con dos consecuencias feas:
 *
 *  - El cliente recibía "Error interno del servidor" cuando en realidad el
 *    problema era SUYO y accionable ("mandaste 3 MB", "el JSON está roto").
 *    Se descubrió con la importación masiva de Documentos: un archivo
 *    grande devolvía 500 en vez de 413.
 *  - Monitoreo: un 5xx significa "se rompió el servidor" y despierta a
 *    alguien. Un cuerpo malformado es un 4xx y no debería paginar a nadie.
 *
 *  Solo se confía en el status si es un 4xx conocido de body-parser; nada
 *  de dejar que un error arbitrario elija su propio código de respuesta. */
function statusDeBodyParser(error: unknown): number | undefined {
  const err = error as { type?: string; status?: number; statusCode?: number };
  const tiposConocidos = [
    "entity.too.large",
    "entity.parse.failed",
    "entity.verify.failed",
    "request.aborted",
    "request.size.invalid",
    "parameters.too.many",
    "charset.unsupported",
    "encoding.unsupported",
  ];
  if (!err?.type || !tiposConocidos.includes(err.type)) return undefined;

  const status = err.status ?? err.statusCode;
  return typeof status === "number" && status >= 400 && status < 500 ? status : undefined;
}

const MENSAJES_BODY_PARSER: Record<string, string> = {
  "entity.too.large": "El contenido enviado supera el tamaño máximo permitido.",
  "entity.parse.failed": "El cuerpo de la petición no es JSON válido.",
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const requestId = getRequestId(req);
  const statusBodyParser = statusDeBodyParser(error);

  const statusCode = error instanceof AppError ? error.statusCode : (statusBodyParser ?? 500);
  const message =
    error instanceof AppError
      ? error.message
      : statusBodyParser
        ? (MENSAJES_BODY_PARSER[(error as { type: string }).type] ??
          "La petición no se pudo procesar.")
        : "Error interno del servidor.";

  // requestId/tenantId/usuarioId ya no hace falta pasarlos a mano: el
  // mixin de config/logger.ts los toma del AsyncLocalStorage de
  // requestContext.ts y los agrega a cualquier log de este request,
  // incluido este.
  if (req.log) {
    if (statusCode >= 500) {
      req.log.error({ err: error }, "Error no controlado en la API");
    } else {
      req.log.warn({ err: error }, "Error de negocio en la API");
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
