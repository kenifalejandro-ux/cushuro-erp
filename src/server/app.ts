/** src/app.ts */

import { randomUUID } from "crypto";
import path from "path";
import compression from "compression";
import cors from "cors";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { corsOptions } from "./middleware/originGuard";
import { createPublicRouter } from "./routes/public";
import { createSystemRouter } from "./routes/system";
import { createApiRouter } from "./routes";
import { getRequestId } from "./shared/utils/request";


const requestLogger = pinoHttp({
  logger,
  genReqId(req, res) {
    const requestId =
      typeof req.headers["x-request-id"] === "string"
        ? req.headers["x-request-id"]
        : randomUUID();
    res.setHeader("x-request-id", requestId);
    return requestId;
  },
  autoLogging: {
    ignore: (req) => req.url === "/status" || req.url === "/health",
  },
  customLogLevel(_req, res, error) {
    if (error || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
}) as unknown as RequestHandler;

const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: { policy: "same-site" },
  referrerPolicy: { policy: "no-referrer" },
  hsts: env.isProduction
    ? {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      }
    : false,
}) as unknown as RequestHandler;

const compressionMiddleware = compression({ threshold: 1024 }) as unknown as RequestHandler;
const corsMiddleware = cors(corsOptions) as unknown as RequestHandler;
const jsonMiddleware = express.json({ limit: env.bodyLimit }) as unknown as RequestHandler;
const urlencodedMiddleware = express.urlencoded({
  extended: false,
  limit: env.bodyLimit,
}) as unknown as RequestHandler;

const noStoreMiddleware: RequestHandler = (req, res, next) => {
  if (req.path === "/status" || req.path === "/health" || req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
};

const notFoundApiHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ message: "Ruta API no encontrada." });
};

const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const requestId = getRequestId(req);
  if (req.log) {
    req.log.error({ err: error, requestId }, "Error no controlado en la API");
  } else {
    console.error("Error no controlado en la API", error);
  }

  if (res.headersSent) return;

  res.status(500).json({
    message: "Error interno del servidor.",
    requestId,
  });
};

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use(requestLogger);
  app.use(helmetMiddleware);
  app.use(compressionMiddleware);
  app.use(corsMiddleware);
  app.use(jsonMiddleware);
  app.use(urlencodedMiddleware);
  app.use(noStoreMiddleware);

  // Rutas generales (sin prefijo)
  app.use(createSystemRouter());
  app.use(createPublicRouter());

  // Rutas del ERP (con prefijo /api)
  app.use("/api/erp", createApiRouter());

  // Manejo de rutas no encontradas
  app.use("/api", notFoundApiHandler);

  // Servir frontend en producción
  if (env.isProduction) {
    const distPath = path.resolve(process.cwd(), "client", "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.use(errorHandler);

  return app;
}