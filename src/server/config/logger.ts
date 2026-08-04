/**src/server/config/logger.ts */

import pino from "pino";
import { env } from "./env";
import { getRequestContext } from "../shared/requestContext";
import { sanitizeSensitiveFields } from "../shared/security/sanitizeLog";

/** Separado de `logger` para que los tests puedan armar su propia instancia
 *  de pino con un stream capturable (`pino(loggerOptions, stream)`) sin
 *  duplicar mixin/redact/formatters. No incluye `transport`: pino no
 *  permite combinar `transport` con un stream propio pasado como segundo
 *  argumento. */
export const loggerOptions: pino.LoggerOptions = {
  level: env.logLevel,
  // Enriquecimiento automático de tenantId/usuarioId/requestId desde el
  // AsyncLocalStorage de requestContext.ts — así cualquier logger.info()
  // (incluso desde un service, sin acceso a req.log) queda igual de
  // trazable que los logs que emite pino-http. Se hereda en los child
  // loggers (req.log de pino-http incluido).
  mixin() {
    const ctx = getRequestContext();
    if (!ctx) return {};
    return {
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      ...(ctx.usuarioId ? { usuarioId: ctx.usuarioId } : {}),
    };
  },
  // Redacción genérica por nombre de key, en cualquier profundidad (ver
  // sanitizeLog.ts) — complementa los paths fijos de abajo, que cubren
  // casos que un match por nombre no detectaría (p. ej. "cookie").
  formatters: {
    log: (object) => sanitizeSensitiveFields(object),
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "body.recaptcha_token",
      "body.website",
      "validatedBody.recaptcha_token",
      "validatedBody.website",
      "err.config.headers.Authorization",
    ],
    censor: "[redacted]",
  },
};

export const logger = pino({
  ...loggerOptions,
  transport:
    !env.isProduction && process.stdout.isTTY
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
});
