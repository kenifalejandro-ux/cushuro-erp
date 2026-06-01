import Redis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

type RedisClient = InstanceType<typeof Redis>;

let client: RedisClient | null = null;

if (env.redisUrl || env.redisHost) {
  const redisClient = env.redisUrl
    ? new Redis(env.redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        lazyConnect: true,
        retryStrategy: () => null,
      })
    : new Redis({
        host: env.redisHost,
        port: env.redisPort,
        password: env.redisPassword || undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        lazyConnect: true,
        retryStrategy: () => null,
      });

  redisClient.on("ready", () => {
    client = redisClient;
    logger.info("Redis listo y conectado");
  });

  redisClient.on("close", () => {
    client = null;
  });

  redisClient.on("error", (error: Error) => {
    logger.error({ err: error }, "Redis error");
  });

  redisClient.connect().catch((error: Error) => {
    logger.warn({ err: error }, "No se pudo conectar a Redis");
  });
} else {
  logger.warn("REDIS_URL/REDIS_HOST no configurado, Redis desactivado");
}

export function getRedis() {
  return client;
}
