/** src/server/shared/middlewares/requestContext.middleware.ts
 *
 * Va justo después de requestLogger (pino-http) en app.ts — necesita que
 * req.id ya esté asignado. Envuelve el resto de la cadena de middlewares
 * en el AsyncLocalStorage de requestContext.ts, así todo lo que corra
 * después (controllers, services, el error handler, res.on("finish")) ve
 * el mismo contexto de petición sin tener que recibir `req` como parámetro.
 */
import type { RequestHandler } from "express";
import { runWithRequestContext } from "../requestContext";

export const requestContextMiddleware: RequestHandler = (req, _res, next) => {
  runWithRequestContext(req, next);
};
