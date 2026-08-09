/** src/server/middleware/erpRateLimiter.ts
 *
 * Rate limit para las rutas de negocio (/api/erp/*), en DOS niveles.
 * Ver docs/architecture/cuotas-por-tenant.md.
 *
 * ── Por qué por USUARIO y no por IP ──────────────────────────────────────
 *
 * La IP no identifica a nadie en este despliegue. Los operarios en oficina
 * salen todos por el NAT de la empresa (una IP para 50 personas), y los que
 * están en planta usan datos móviles, donde la operadora hace CGNAT (una IP
 * para miles de abonados) y además la IP CAMBIA al moverse entre antenas.
 * O sea: demasiado gruesa y demasiado inestable a la vez. Con población
 * mixta, el MISMO límite se comportaba distinto según desde dónde se
 * conectara cada uno — imposible de explicar y de diagnosticar.
 *
 * El argumento que cierra la discusión: este middleware corre DESPUÉS de
 * authMiddleware, así que nunca ve tráfico anónimo (un request sin
 * credenciales muere con 401 antes de llegar acá). No protege de un
 * desconocido: protege de un cliente AUTENTICADO descontrolado — un script
 * en loop, una integración mal hecha, una cuenta comprometida. En todos
 * esos casos hay un usuario identificado, y esa es la identidad correcta
 * para contar.
 *
 * OJO con lo que esto NO cubre: un DoS volumétrico real no lo frena ningún
 * límite de acá, porque para cuando el request llega a este middleware ya
 * consumió una conexión, ya pasó por Express, ya validó un JWT y ya tocó
 * Redis. Eso se frena antes de Node (reverse proxy / CDN / infraestructura).
 *
 * ── Los dos niveles ──────────────────────────────────────────────────────
 *
 *   1. Por usuario  → fusible. Un humano no sostiene 120 req/min; un bucle
 *      sí. NO depende del plan a propósito: un operario de una MYPE hace
 *      clic a la misma velocidad que uno de una Corporativo, y castigarlo
 *      por el tamaño de su empresa sería absurdo. Es un fusible técnico, no
 *      una diferenciación comercial.
 *
 *   2. Por tenant   → techo. Existe para proteger a los DEMÁS clientes: sin
 *      él, una empresa entera desbocada degrada el servicio de todas las
 *      otras en el mismo servidor.
 *
 * ── Un detalle que no es obvio ───────────────────────────────────────────
 *
 * Cuando un usuario choca contra SU fusible, el request NO incrementa el
 * contador del tenant. Si lo hiciera, un solo script descontrolado se
 * comería el presupuesto de toda la empresa y terminaría bloqueando a sus
 * compañeros — exactamente el daño que el nivel por usuario existe para
 * contener. Por eso se chequea usuario primero y se corta ahí.
 */
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { getRedis } from "../config/redis";
import { getClientIp, getRequestId } from "../shared/utils/request";
import { resolverRateLimitTenant } from "../services/platformRateLimitCuota";
import { asyncHandler } from "../shared/utils/asyncHandler";

type EntradaMemoria = { count: number; resetAt: number };

const memoria = new Map<string, EntradaMemoria>();

// Mismo barrido que memoryStore en rateLimiter.ts: sin esto el Map (fallback
// sin Redis) acumula una entrada muerta por cada usuario y cada tenant.
setInterval(() => {
  const ahora = Date.now();
  for (const [clave, entrada] of memoria) {
    if (ahora >= entrada.resetAt) memoria.delete(clave);
  }
}, 5 * 60_000).unref();

/** `excedido: false` cuando todavía hay cupo. `retryAfterSeconds` solo tiene
 *  sentido cuando se excedió. */
async function consumirCupo(
  clave: string,
  maximo: number,
  windowMs: number,
  req: Request
): Promise<{ excedido: boolean; retryAfterSeconds: number }> {
  const redis = getRedis();

  if (redis) {
    try {
      const intentos = await redis.incr(clave);
      if (intentos === 1) await redis.pexpire(clave, windowMs);

      if (intentos > maximo) {
        const ttl = await redis.pttl(clave);
        return {
          excedido: true,
          retryAfterSeconds:
            ttl > 0 ? Math.max(1, Math.ceil(ttl / 1000)) : Math.ceil(windowMs / 1000),
        };
      }
      return { excedido: false, retryAfterSeconds: 0 };
    } catch (error) {
      // Un fallo de Redis NO puede tumbar el ERP: se cae al contador en
      // memoria, que es peor (no se comparte entre instancias) pero sigue
      // siendo un límite real. Mismo criterio que rateLimiter.ts.
      req.log?.error(
        { err: error, requestId: getRequestId(req) },
        "Redis falló en el rate limit del ERP, se usa memoria"
      );
    }
  }

  const ahora = Date.now();
  const actual = memoria.get(clave);

  if (!actual || ahora >= actual.resetAt) {
    memoria.set(clave, { count: 1, resetAt: ahora + windowMs });
    return { excedido: false, retryAfterSeconds: 0 };
  }

  actual.count += 1;
  if (actual.count > maximo) {
    return {
      excedido: true,
      retryAfterSeconds: Math.max(1, Math.ceil((actual.resetAt - ahora) / 1000)),
    };
  }
  return { excedido: false, retryAfterSeconds: 0 };
}

/** Los dos niveles dan mensajes distintos porque se resuelven distinto: el
 *  personal se arregla esperando, el del tenant es señal de que la empresa
 *  necesita más capacidad (o tiene una integración descontrolada). Con un
 *  solo mensaje, un cliente que necesita atención recibiría lo mismo que
 *  uno que solo tiene que esperar dos segundos. */
function responder429(res: Response, nivel: "usuario" | "tenant", retryAfterSeconds: number) {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  return res.status(429).json({
    ok: false,
    error: nivel === "usuario" ? "rate_limit_usuario" : "rate_limit_tenant",
    nivel,
    message:
      nivel === "usuario"
        ? "Estás haciendo demasiadas peticiones. Esperá un momento antes de continuar."
        : "Tu empresa alcanzó el límite de peticiones por minuto. Esperá un momento o contactá al administrador.",
    retryAfterSeconds,
  });
}

/** Debe montarse después de authMiddleware y tenantMiddleware (necesita
 *  req.usuario y req.tenantId). */
export default asyncHandler(async function erpRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Se leen de env en cada request y no al cargar el módulo: permite
  // ajustarlos en tests sin recargar módulos, igual que el driver de backups.
  const { erpRateLimitWindowMs: windowMs, erpRateLimitUsuarioMax } = env;

  // authMiddleware ya corrió, así que req.usuario existe siempre. El fallback
  // a IP es defensa en profundidad por si alguien monta este middleware en
  // una cadena sin auth: preferible limitar por algo imperfecto que no
  // limitar nada.
  const idUsuario = req.usuario?.id ?? `ip:${getClientIp(req)}`;
  const idTenant = req.tenantId ?? "sin-tenant";

  // ── Nivel 1: el fusible personal ──────────────────────────────────────
  if (erpRateLimitUsuarioMax > 0) {
    const usuario = await consumirCupo(`erp:u:${idUsuario}`, erpRateLimitUsuarioMax, windowMs, req);
    if (usuario.excedido) {
      req.log?.warn(
        { usuarioId: req.usuario?.id, tenantId: req.tenantId, nivel: "usuario" },
        "Rate limit del ERP: usuario excedido"
      );
      // Se corta ACÁ, sin tocar el contador del tenant: ver el encabezado.
      return responder429(res, "usuario", usuario.retryAfterSeconds);
    }
  }

  // ── Nivel 2: el techo de la empresa ───────────────────────────────────
  // El techo sale de tenant_cuotas (override de ESE cliente) o del default
  // global, resuelto con caché en Redis para no consultar Postgres en cada
  // request — ver platformRateLimitCuota.ts. `null` = sin techo.
  const techoTenant = await resolverRateLimitTenant(idTenant);
  if (techoTenant !== null && techoTenant > 0) {
    const tenant = await consumirCupo(`erp:t:${idTenant}`, techoTenant, windowMs, req);
    if (tenant.excedido) {
      req.log?.warn(
        { tenantId: req.tenantId, nivel: "tenant", techo: techoTenant },
        "Rate limit del ERP: tenant excedido"
      );
      return responder429(res, "tenant", tenant.retryAfterSeconds);
    }
  }

  next();
});
