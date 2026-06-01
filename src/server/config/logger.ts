/**src/server/config/logger.ts */

import pino from "pino";
import { env } from "./env";

export const logger = pino({
  level: env.logLevel,
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
