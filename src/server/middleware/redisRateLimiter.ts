/** src/server/middleware/redisRateLimiter.ts
 *
 * Factory compartida por los rate limiters específicos de plataforma y de
 * auth (platformTenantRateLimiter.ts, platformAdminLoginRateLimiter.ts,
 * loginEmailRateLimiter.ts, forgotPasswordEmailRateLimiter.ts) — cada uno
 * tiene su propia clave de Redis y su propia ventana/límite configurable
 * por env, pero el mecanismo (INCR+PEXPIRE en Redis, con fallback a un Map
 * en memoria si Redis no está disponible) es idéntico. No reemplaza al
 * rateLimiter genérico (middleware/rateLimiter.ts) — ese sigue
 * aplicándose antes, sobre `path`+ip, para cualquier formulario de la
 * app; esto es la capa adicional para acciones con más blast radius o más
 * riesgo (crear un tenant, adivinar una contraseña) que no deben
 * compartir ventana con el resto.
 */
import type { NextFunction, Request, Response } from "express";
import { getRedis } from "../config/redis";
import { getClientIp } from "../shared/utils/request";
import { pool } from "../config/database";
import { escribirEventoOutbox } from "../services/platformOutbox.service";
import { logger } from "../config/logger";
import { asyncHandler } from "../shared/utils/asyncHandler";

type MemoryEntry = { count: number; resetAt: number };

/** Factory genérica: el "sujeto" del límite lo decide `extraerClave` (IP,
 *  email+tenant, lo que haga falta) — el resto (Redis+memoria, backoff,
 *  alerta de ráfaga) es idéntico sea cual sea el sujeto. `undefined` de
 *  `extraerClave` significa "nada que limitar en este request" (ej. el
 *  campo que hace falta para armar la clave no está en el body) y deja
 *  pasar sin contar: la validación de schema previa ya se encarga de
 *  rechazar un body incompleto, este middleware no debe fallar cerrado
 *  por eso. */
export function crearLimitador(opciones: {
  prefijoClave: string;
  windowMs: number;
  maxRequests: number;
  mensaje: string;
  extraerClave: (req: Request) => string | undefined;
}) {
  const memoryStore = new Map<string, MemoryEntry>();

  setInterval(() => {
    const ahora = Date.now();
    for (const [key, entry] of memoryStore) {
      if (ahora >= entry.resetAt) memoryStore.delete(key);
    }
  }, 5 * 60_000).unref();

  // Solo en la PRIMERA request rechazada de cada ventana (intentos ===
  // maxRequests + 1) — sin esto, una ráfaga real generaría un evento de
  // outbox por cada request de más, en vez de uno solo avisando que la
  // ráfaga empezó. Best-effort: si esto falla, la respuesta 429 al
  // cliente no se ve afectada (ver el try/catch alrededor).
  async function avisarPrimerRechazo(ip: string, sujeto: string, retryAfterSeconds: number) {
    try {
      await escribirEventoOutbox(pool, {
        tipo: "alerta_rafaga",
        payload: {
          limitador: opciones.prefijoClave,
          ip,
          sujeto,
          maxRequests: opciones.maxRequests,
          retryAfterSeconds,
        },
      });
    } catch (err) {
      logger.warn({ err }, "No se pudo registrar el evento de outbox de ráfaga");
    }
  }

  function rechazar(res: Response, retryAfterSeconds: number) {
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({ ok: false, message: opciones.mensaje, retryAfterSeconds });
  }

  return asyncHandler(async function limitar(req: Request, res: Response, next: NextFunction) {
    const sujeto = opciones.extraerClave(req);
    if (sujeto === undefined) return next();

    const ip = getClientIp(req);
    const key = `${opciones.prefijoClave}:${sujeto}`;
    const redis = getRedis();

    if (redis) {
      try {
        const intentos = await redis.incr(key);
        if (intentos === 1) await redis.pexpire(key, opciones.windowMs);

        if (intentos > opciones.maxRequests) {
          const ttl = await redis.pttl(key);
          const retryAfterSeconds =
            ttl > 0 ? Math.max(1, Math.ceil(ttl / 1000)) : Math.ceil(opciones.windowMs / 1000);
          if (intentos === opciones.maxRequests + 1)
            await avisarPrimerRechazo(ip, sujeto, retryAfterSeconds);
          return rechazar(res, retryAfterSeconds);
        }
        return next();
      } catch {
        // cae al fallback en memoria si Redis falla a mitad de camino
      }
    }

    const ahora = Date.now();
    const actual = memoryStore.get(key);
    if (!actual || ahora >= actual.resetAt) {
      memoryStore.set(key, { count: 1, resetAt: ahora + opciones.windowMs });
      return next();
    }

    actual.count += 1;
    if (actual.count > opciones.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((actual.resetAt - ahora) / 1000));
      if (actual.count === opciones.maxRequests + 1)
        await avisarPrimerRechazo(ip, sujeto, retryAfterSeconds);
      return rechazar(res, retryAfterSeconds);
    }

    memoryStore.set(key, actual);
    next();
  });
}

/** El caso más común: limitar por IP del request. */
export function crearLimitadorPorIp(opciones: {
  prefijoClave: string;
  windowMs: number;
  maxRequests: number;
  mensaje: string;
}) {
  return crearLimitador({ ...opciones, extraerClave: getClientIp });
}
