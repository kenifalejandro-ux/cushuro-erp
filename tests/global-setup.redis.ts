/** tests/global-setup.redis.ts
 *
 * Levanta un Redis real y efímero para la corrida de tests, si:
 *   a) no hay uno ya configurado por fuera (REDIS_HOST/REDIS_URL en el
 *      entorno — típicamente el service container de .github/workflows/ci.yml),
 *      y
 *   b) el paquete `redis-memory-server` está disponible (devDependency
 *      opcional — ver package.json; si no está instalado, se sigue sin
 *      Redis en vez de romper la corrida de tests).
 *
 * Sin esto, todo lo que depende de Redis (sesiones de platform_admin
 * revocables, dedupe de auditoría, idempotency-key, rate limiters
 * específicos) corre siempre en su modo degradado en local — nunca se
 * ejercita el camino real, solo el de fallback. tests/platform-admins.test.ts
 * detecta en tiempo de ejecución si terminó habiendo Redis disponible (sea
 * por acá, por CI, o por un Redis local de verdad) y activa/salta según
 * corresponda — nunca asume un modo fijo.
 *
 * Vitest corre `setup()` en el proceso principal ANTES de levantar los
 * workers que importan el código de la app — mutar `process.env` acá es
 * lo que le permite a `src/server/config/env.ts` (que lee REDIS_HOST una
 * sola vez, al importarse) verlo.
 */
import type RedisMemoryServer from "redis-memory-server";

let servidor: RedisMemoryServer | undefined;

export async function setup() {
  if (process.env.REDIS_HOST || process.env.REDIS_URL) {
    console.log(
      "[tests] REDIS_HOST/REDIS_URL ya configurado por fuera, no se levanta uno efímero."
    );
    return;
  }

  let Ctor: typeof RedisMemoryServer;
  try {
    ({ RedisMemoryServer: Ctor } = await import("redis-memory-server"));
  } catch {
    console.warn(
      "[tests] redis-memory-server no está instalado — los tests que necesitan Redis real se van a saltear " +
        "(instalalo como devDependency, o corré contra un Redis real con REDIS_HOST/REDIS_PORT en el entorno)."
    );
    return;
  }

  try {
    const instancia = new Ctor();
    await instancia.start();
    process.env.REDIS_HOST = await instancia.getHost();
    process.env.REDIS_PORT = String(await instancia.getPort());
    servidor = instancia;
    console.log(
      `[tests] Redis efímero (redis-memory-server) en ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`
    );
  } catch (err) {
    console.warn("[tests] No se pudo levantar redis-memory-server, se sigue sin Redis:", err);
  }
}

export async function teardown() {
  if (servidor) await servidor.stop();
}
