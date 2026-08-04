/** src/app.ts */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type RequestHandler } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { corsOptions } from "./middleware/originGuard";
import { authRouter } from "./routes/auth";
import { createPublicRouter } from "./routes/public";
import { createSystemRouter } from "./routes/system";
import { createPlatformRouter } from "./routes/platform";
import { createScimRouter } from "./routes/scim";
import { createApiRouter } from "./routes";
import { errorHandler } from "./shared/middlewares/error.middleware";
import { requestContextMiddleware } from "./shared/middlewares/requestContext.middleware";


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
const jsonMiddleware = express.json({
  limit: env.bodyLimit,
  // Guarda el body crudo para poder validar firmas HMAC de futuros webhooks
  // (pagos, integraciones) sin tener que reserializar el JSON parseado.
  verify: (req, _res, buf) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  },
}) as unknown as RequestHandler;
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

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  // "true" confía en CUALQUIER proxy de la cadena, lo que permite spoofear
  // X-Forwarded-For y falsear req.ip (usado por el rate limiter de /login y
  // por reCAPTCHA) desde el propio cliente. "1" confía solo en el primer
  // hop (el balanceador de Railway/reverse proxy real) — ajustar el número
  // si en producción hay más saltos de proxy antes de llegar a esta app.
  app.set("trust proxy", 1);

  app.use(requestLogger);
  // Después de requestLogger (necesita req.id ya asignado) y antes de todo
  // lo demás: envuelve el resto de la cadena en el AsyncLocalStorage de
  // requestContext.ts para que tenantId/usuarioId/requestId queden
  // disponibles para el logger en cualquier punto, no solo vía req.log.
  app.use(requestContextMiddleware);
  app.use(helmetMiddleware);
  app.use(compressionMiddleware);
  app.use(corsMiddleware);
  app.use(cookieParser() as unknown as RequestHandler);
  app.use(jsonMiddleware);
  app.use(urlencodedMiddleware);
  app.use(noStoreMiddleware);

  // Rutas generales (sin prefijo)
  app.use(createSystemRouter());
  app.use(createPublicRouter());

  // Autenticación (fuera del prefijo /api/erp: es transversal, no un módulo de negocio)
  app.use("/api/auth", authRouter);

  // Onboarding de tenants: protegido por platformAdminMiddleware (secreto
  // de plataforma), no por el JWT de usuario — no es una acción de un
  // tenant, es de quien opera el ERP.
  app.use("/api/platform", createPlatformRouter());

  // Provisioning SCIM por tenant (ver platformScim.service.ts) — fuera de
  // /api a propósito, mismo criterio que el resto del ecosistema SCIM: es
  // la ruta que un IdP externo espera encontrar, no una convención propia
  // de esta app. Autenticado por su propio bearer token (scim.middleware.ts),
  // sin relación con el JWT de usuario ni con la sesión del panel.
  app.use("/scim/v2", createScimRouter());

  // Rutas del ERP (con prefijo /api) — protegidas por authMiddleware/tenantMiddleware
  // dentro de cada módulo (ver routes/index.ts)
  app.use("/api/erp", createApiRouter());

  // Manejo de rutas no encontradas
  app.use("/api", notFoundApiHandler);

  // Servir frontend si el build existe
  const distPath = path.resolve(process.cwd(), "client", "dist");
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath) as unknown as RequestHandler);
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.use(errorHandler);

  return app;
}