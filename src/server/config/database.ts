/** src/server/config/database.ts */

import { Pool } from "pg";
import { env } from "./env";
import { logger } from "./logger";

// Sin TLS en localhost (no aporta nada); certificado validado en cualquier
// host remoto — Railway y cualquier otro proveedor SaaS entregan un cert válido.
const hostRemoto = Boolean(process.env.DATABASE_URL) ||
  !["localhost", "127.0.0.1", "::1"].includes(env.dbHost);

// Railway provee DATABASE_URL; en local usamos las variables individuales
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: hostRemoto ? { rejectUnauthorized: true } : false,
    }
  : {
      host: env.dbHost,
      user: env.dbUser,
      password: env.dbPass,
      database: env.dbName,
      port: env.dbPort,
      ssl: env.isProduction && hostRemoto ? { rejectUnauthorized: true } : false,
    };

export const pool = new Pool({
  ...poolConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});


// ====================== EVENTOS DEL POOL ======================
pool.on("connect", () => {
  logger.debug("Nueva conexión establecida con PostgreSQL");
});

pool.on("error", (err) => {
  logger.error({ err }, "Error inesperado en el pool de PostgreSQL");
});

pool.on("remove", () => {
  logger.debug("Conexión removida del pool");
});

// ====================== FUNCIÓN DE TEST ======================
export async function testDatabaseConnection(): Promise<boolean> {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query("SELECT NOW() as current_time");
    
    logger.info({
      message: "✅ Conexión a PostgreSQL exitosa",
      timestamp: result.rows[0].current_time,
      database: env.dbName || "zincel_rp"

    });

    return true;
  } catch (error: any) {
    logger.error({
      err: error,
      message: "❌ Error al conectar con PostgreSQL",
      detail: error.message
    });
    return false;
  } finally {
    if (client) client.release();
  }
}

// ====================== FUNCIÓN PARA CERRAR ======================
export async function closeDatabase(): Promise<void> {
  try {
    await pool.end();
    logger.info("Pool de PostgreSQL cerrado correctamente");
  } catch (error) {
    logger.warn({ err: error }, "Error al cerrar el pool de PostgreSQL");
  }
}