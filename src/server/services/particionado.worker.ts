/** src/server/services/particionado.worker.ts
 *
 * Aprovisionamiento continuo de particiones para checklists/ipercs (ver
 * migrations/0037_particionado_tablas.sql y
 * docs/architecture/particionado-de-tablas.md). Sin esto, un INSERT en un
 * mes que todavía no tiene partición creada fallaría —la migración solo
 * crea el mes actual + 3 futuros una vez, al aplicarse—: este worker
 * corre todos los días y llama a la misma función SQL
 * (particiones_asegurar_futuras) que usó la migración inicial, así el
 * margen de 3 meses nunca se termina de gastar.
 *
 * La función SQL, no este archivo, decide CÓMO crear una partición
 * (nombre, rango, RLS) — acá solo se la llama con la cadencia correcta.
 * Mismo motivo que particion_rls_asegurar() está centralizada en SQL: que
 * la migración inicial y las corridas periódicas nunca puedan divergir en
 * el paso de seguridad (RLS por partición).
 */
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { env } from "../config/env";

export async function asegurarParticionesFuturas(): Promise<void> {
  await pool.query("SELECT particiones_asegurar_futuras($1)", [env.particionesMesesAdelante]);
}

setInterval(() => {
  asegurarParticionesFuturas().catch((err) =>
    logger.error({ err }, "Error al asegurar las particiones futuras de checklists/ipercs")
  );
}, env.particionesCheckIntervalMs).unref();
