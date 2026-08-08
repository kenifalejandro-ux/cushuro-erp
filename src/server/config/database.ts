/** src/server/config/database.ts */

import { Pool, type PoolClient } from "pg";
import { env } from "./env";
import { logger } from "./logger";

// Sin TLS en localhost (no aporta nada); certificado validado en cualquier
// host remoto — Railway y cualquier otro proveedor SaaS entregan un cert válido.
const hostRemoto =
  Boolean(process.env.DATABASE_URL) || !["localhost", "127.0.0.1", "::1"].includes(env.dbHost);

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
      database: env.dbName || "zincel_rp",
    });

    return true;
  } catch (error: any) {
    logger.error({
      err: error,
      message: "❌ Error al conectar con PostgreSQL",
      detail: error.message,
    });
    return false;
  } finally {
    if (client) client.release();
  }
}

// ====================== AISLAMIENTO MULTI-TENANT (RLS) ======================
// pool.query() puede usar una conexión distinta en cada llamada, así que no
// sirve para setear una variable de sesión que después lean las políticas
// de Row-Level Security (ver migrations/0005_rls_tenant_isolation.sql).
// Por eso acá se reserva un client dedicado del pool para toda la duración
// del request, dentro de una transacción: set_config con is_local=true deja
// app.tenant_id visible solo hasta el COMMIT/ROLLBACK de esta transacción,
// nunca se filtra a la siguiente vez que ese client vuelva al pool.
//
// El filtro por tenant_id en el WHERE de cada query (ver los repositorios)
// sigue siendo el mecanismo principal — esto es la red de seguridad si
// alguna query nueva se olvida de filtrar.
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
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
