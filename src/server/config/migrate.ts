/** src/server/config/migrate.ts
 *
 * Corre las migraciones pendientes de migrations/*.sql contra la BD, en
 * orden por nombre de archivo (el prefijo numérico ya lo garantiza). Se
 * llama al arrancar el server (ver bootstrap.ts) — así "npm start" deja la
 * base al día sola, sin depender de que alguien corra psql a mano antes
 * del deploy.
 */
import fs from "fs";
import path from "path";
import { pool } from "./database";
import { logger } from "./logger";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

// Número arbitrario pero fijo: identifica este lock específico entre
// todos los que pueda tomar la app. Evita que dos instancias arrancando
// al mismo tiempo corran la misma migración dos veces.
const MIGRATION_LOCK_ID = 483920;

export async function runMigrations(): Promise<void> {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    logger.warn("No existe carpeta migrations/, se omite runMigrations()");
    return;
  }

  const archivos = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const yaAplicadas = new Set(
      (await client.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename)
    );

    for (const archivo of archivos) {
      if (yaAplicadas.has(archivo)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, archivo), "utf-8");
      logger.info({ archivo }, "Aplicando migración");

      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [archivo]);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    client.release();
  }
}
