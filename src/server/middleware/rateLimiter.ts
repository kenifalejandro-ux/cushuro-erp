import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { getRedis } from "../config/redis";
import { getClientIp, getRequestId } from "../shared/utils/request";

type MemoryEntry = { count: number; resetAt: number };

const memoryStore = new Map<string, MemoryEntry>();

// Sin esto, memoryStore (fallback cuando no hay Redis) crece sin límite: cada
// combinación nueva de ip+ruta queda huérfana en el Map una vez vencida.
// Barrido periódico simple, sin dependencias ni cambios de comportamiento.
setInterval(() => {
  const timestamp = Date.now();
  for (const [key, entry] of memoryStore) {
    if (timestamp >= entry.resetAt) {
      memoryStore.delete(key);
    }
  }
}, 5 * 60_000).unref();

function now() {
  return Date.now();
}

function sendRateLimitResponse(req: Request, res: Response, retryAfterSeconds: number) {
  res.setHeader("Retry-After", String(retryAfterSeconds));

  if (req.path.startsWith("/api/")) {
    return res.status(429).json({
      message: "Demasiados intentos. Espera un momento antes de volver a enviar.",
      retryAfterSeconds,
    });
  }

  return res.status(429).send("Demasiados intentos. Espera un momento antes de volver a enviar.");
}

export default async function rateLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = getClientIp(req);
  const requestId = getRequestId(req);
  const key = `form:${req.path}:${ip}`;
  const redis = getRedis();

  if (redis) {
    try {
      const attempts = await redis.incr(key);

      if (attempts === 1) {
        await redis.pexpire(key, env.rateLimitWindowMs);
      }

      if (attempts > env.rateLimitMaxRequests) {
        const ttl = await redis.pttl(key);
        const retryAfterSeconds =
          ttl > 0 ? Math.max(1, Math.ceil(ttl / 1000)) : Math.ceil(env.rateLimitWindowMs / 1000);

        if (req.log) {
          req.log.warn(
            { ip, attempts, retryAfterSeconds, requestId },
            "Rate limit bloqueando formulario"
          );
        } else {
          console.warn("Rate limit bloqueando formulario", {
            ip,
            attempts,
            retryAfterSeconds,
            requestId,
          });
        }

        return sendRateLimitResponse(req, res, retryAfterSeconds);
      }

      return next();
    } catch (error) {
      if (req.log) {
        req.log.error({ err: error, requestId }, "Redis fallo en rate limiting");
      } else {
        console.error("Redis fallo en rate limiting", { error, requestId });
      }
    }
  }

  const timestamp = now();
  const current = memoryStore.get(key);

  if (!current || timestamp >= current.resetAt) {
    memoryStore.set(key, { count: 1, resetAt: timestamp + env.rateLimitWindowMs });
    return next();
  }

  current.count += 1;
  memoryStore.set(key, current);

  if (current.count > env.rateLimitMaxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - timestamp) / 1000));

    if (req.log) {
      req.log.warn(
        { ip, attempts: current.count, retryAfterSeconds, requestId },
        "Rate limit en memoria bloqueando formulario"
      );
    } else {
      console.warn("Rate limit en memoria bloqueando formulario", {
        ip,
        attempts: current.count,
        retryAfterSeconds,
        requestId,
      });
    }

    return sendRateLimitResponse(req, res, retryAfterSeconds);
  }

  next();
}
