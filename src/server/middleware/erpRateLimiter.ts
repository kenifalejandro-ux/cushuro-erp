/** src/server/middleware/erpRateLimiter.ts
 *
 * Rate limit para las rutas de negocio (/api/erp/*). Hasta acá esas rutas
 * NO tenían ninguno: el rateLimiter genérico solo cubre auth y el panel de
 * plataforma, así que un cliente podía pegarle al ERP sin techo de
 * frecuencia. Las cuotas por tenant frenan el VOLUMEN acumulado (cuántos
 * registros), no la FRECUENCIA — nada impedía 10.000 GET por segundo.
 * Ver docs/architecture/cuotas-por-tenant.md.
 *
 * ── Por qué es un middleware aparte y no el rateLimiter existente ────────
 *
 * El genérico usa la clave `form:{ruta}:{ip}` con un presupuesto pensado
 * para formularios (5/min por default): un contador por RUTA, para frenar
 * fuerza bruta contra un endpoint puntual. Acá hace falta lo contrario —
 * un presupuesto compartido por TODO el tráfico del tenant, sin importar
 * qué ruta toque, porque el abuso que interesa frenar es el volumen total.
 *
 * ── La clave, y su límite conocido ──────────────────────────────────────
 *
 * `erp:{tenantId}:{ip}`. La componente de tenant es lo que evita que un
 * cliente abusivo consuma el presupuesto de otro (con la clave por IP sola,
 * dos tenants detrás del mismo proxy compartirían cupo).
 *
 * OJO con el caso real: un tenant cuyos usuarios salen todos por una misma
 * IP corporativa (NAT) comparte UN presupuesto entre todo el personal. Con
 * el default de 300/min y 50 usuarios activos son 6 requests/minuto cada
 * uno, que para un ERP en uso real puede quedar corto. Es la razón por la
 * que el límite es configurable y no una constante: si un cliente reporta
 * 429 en uso normal, hay que subirlo — no es un ataque, es NAT.
 */
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { getRedis } from "../config/redis";
import { getClientIp, getRequestId } from "../shared/utils/request";

type EntradaMemoria = { count: number; resetAt: number };

const memoria = new Map<string, EntradaMemoria>();

// Mismo barrido que memoryStore en rateLimiter.ts: sin esto el Map (fallback
// sin Redis) acumula una entrada muerta por cada combinación tenant+ip.
setInterval(() => {
  const ahora = Date.now();
  for (const [clave, entrada] of memoria) {
    if (ahora >= entrada.resetAt) memoria.delete(clave);
  }
}, 5 * 60_000).unref();

function responder429(req: Request, res: Response, retryAfterSeconds: number) {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  // Cuerpo estructurado y con `error` propio para que el cliente lo
  // distinga de una cuota excedida (403 `cuota_excedida`): son cosas
  // distintas —frecuencia vs volumen— y se resuelven distinto (esperar vs
  // pedir más cupo).
  return res.status(429).json({
    ok: false,
    error: "rate_limit_excedido",
    message: "Demasiadas peticiones. Esperá un momento antes de reintentar.",
    retryAfterSeconds,
  });
}

/** Debe montarse después de tenantMiddleware (necesita req.tenantId). */
export default async function erpRateLimiter(req: Request, res: Response, next: NextFunction) {
  // Se lee de env en cada request, no al cargar el módulo: permite ajustar
  // el límite en tests sin recargar módulos, igual que el driver de backups.
  const maxRequests = env.erpRateLimitMaxRequests;
  const windowMs = env.erpRateLimitWindowMs;
  if (maxRequests <= 0) return next(); // 0 = desactivado

  const ip = getClientIp(req);
  const requestId = getRequestId(req);
  const clave = `erp:${req.tenantId ?? "sin-tenant"}:${ip}`;
  const redis = getRedis();

  if (redis) {
    try {
      const intentos = await redis.incr(clave);
      if (intentos === 1) await redis.pexpire(clave, windowMs);

      if (intentos > maxRequests) {
        const ttl = await redis.pttl(clave);
        const retryAfterSeconds = ttl > 0 ? Math.max(1, Math.ceil(ttl / 1000)) : Math.ceil(windowMs / 1000);
        req.log?.warn({ ip, tenantId: req.tenantId, intentos, requestId }, "Rate limit del ERP bloqueando request");
        return responder429(req, res, retryAfterSeconds);
      }
      return next();
    } catch (error) {
      // Un fallo de Redis NO puede tumbar el ERP: se cae al contador en
      // memoria, que es peor (no se comparte entre instancias) pero sigue
      // siendo un límite real. Mismo criterio que rateLimiter.ts.
      req.log?.error({ err: error, requestId }, "Redis falló en el rate limit del ERP, se usa memoria");
    }
  }

  const ahora = Date.now();
  const actual = memoria.get(clave);

  if (!actual || ahora >= actual.resetAt) {
    memoria.set(clave, { count: 1, resetAt: ahora + windowMs });
    return next();
  }

  actual.count += 1;
  if (actual.count > maxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((actual.resetAt - ahora) / 1000));
    req.log?.warn(
      { ip, tenantId: req.tenantId, intentos: actual.count, requestId },
      "Rate limit del ERP (memoria) bloqueando request"
    );
    return responder429(req, res, retryAfterSeconds);
  }

  next();
}
