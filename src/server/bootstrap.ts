/** src/server/bootstrap.ts */

import { createApp } from "./app";
import { env, missingRequiredEnv } from "./config/env";
import { logger } from "./config/logger";
import { getRedis } from "./config/redis";
import { testDatabaseConnection } from "./config/database";
import { runMigrations } from "./config/migrate";

export async function startServer() {
  // ====================== VALIDACIONES INICIALES ======================
  if (missingRequiredEnv.length > 0) {
    const message = `Faltan variables de entorno obligatorias: ${missingRequiredEnv.join(", ")}`;

    if (env.isProduction) {
      logger.error(message);
      throw new Error(message);
    }

    logger.warn({ missingRequiredEnv }, message);
  }

  // ====================== CONEXIÓN A BASE DE DATOS ======================
  logger.info("🔌 Intentando conectar a PostgreSQL...");
  testDatabaseConnection().then(connected => {
    if (!connected && env.isProduction) {
      logger.error("❌ No se pudo conectar a PostgreSQL en entorno de producción");
      process.exit(1);
    }
  });

  // ====================== MIGRACIONES ======================
  // Deja la BD al día sola en cada arranque — sin esto, un deploy sin
  // correr migrations/*.sql a mano primero deja el ERP roto.
  try {
    await runMigrations();
  } catch (err) {
    logger.error({ err }, "❌ Error al correr migraciones, el server no arranca");
    process.exit(1);
  }

  // ====================== INICIO DEL SERVIDOR ======================
  const app = createApp();
  
  const server = app.listen(env.port, () => {
    logger.info(`🚀 MinCore ERP API iniciada correctamente en http://localhost:${env.port}`);
    logger.info(`📊 Entorno: ${env.isProduction ? 'PRODUCCIÓN' : 'DESARROLLO'}`);
  });

  // ====================== SHUTDOWN GRACIOSO ======================
  const shutdown = (signal: string) => {
    logger.info({ signal }, "🛑 Señal de apagado recibida. Cerrando servidor...");

    server.close(async () => {
      logger.info("HTTP Server cerrado.");

      // Cerrar Redis de forma segura (si existe)
      const redis = getRedis();
      if (redis) {
        try {
          await redis.quit();
          logger.info("Redis desconectado correctamente.");
        } catch (error) {
          logger.warn({ err: error }, "No se pudo cerrar Redis limpiamente.");
        }
      }

      logger.info("✅ Servidor cerrado correctamente.");
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}