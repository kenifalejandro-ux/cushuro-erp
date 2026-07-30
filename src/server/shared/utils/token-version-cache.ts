/** src/server/shared/utils/token-version-cache.ts
 *
 * Cache corta (60s) del token_version de cada usuario, para que authMiddleware
 * no tenga que pegarle a Postgres en cada request con sesión activa. Mismo
 * patrón que rateLimiter.ts: Redis si está disponible, memoria como fallback.
 *
 * Una revocación (logoutService / futuras acciones de admin) tarda como
 * máximo TTL_MS en propagarse a los requests ya en curso con la versión
 * vieja en cache — trade-off aceptado a cambio de no consultar la BD en
 * cada request autenticado.
 */
import { getRedis } from "../../config/redis";

const TTL_MS = 60_000;
const memoryCache = new Map<string, { version: number; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryCache) {
    if (now >= entry.expiresAt) memoryCache.delete(key);
  }
}, 5 * 60_000).unref();

function redisKey(usuarioId: string) {
  return `tokenver:${usuarioId}`;
}

export async function getCachedTokenVersion(usuarioId: string): Promise<number | undefined> {
  const redis = getRedis();
  if (redis) {
    try {
      const value = await redis.get(redisKey(usuarioId));
      if (value !== null) return Number(value);
      return undefined;
    } catch {
      // Redis falló: seguimos con la cache en memoria como fallback.
    }
  }

  const cached = memoryCache.get(usuarioId);
  if (cached && Date.now() < cached.expiresAt) return cached.version;
  return undefined;
}

export async function setCachedTokenVersion(usuarioId: string, version: number): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(redisKey(usuarioId), version, "EX", 60);
      return;
    } catch {
      // sigue al fallback en memoria
    }
  }
  memoryCache.set(usuarioId, { version, expiresAt: Date.now() + TTL_MS });
}

export async function invalidateCachedTokenVersion(usuarioId: string): Promise<void> {
  memoryCache.delete(usuarioId);
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(redisKey(usuarioId));
    } catch {
      // no crítico: la entrada en Redis igual expira sola a los 60s
    }
  }
}
