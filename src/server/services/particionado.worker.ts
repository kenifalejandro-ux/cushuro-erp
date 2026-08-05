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
import type { Pool, PoolClient } from "pg";
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { runSiPrimero, LOCK_IDS } from "../shared/utils/advisoryLock";

/** `client` opcional: el worker de abajo pasa el que sostiene el advisory
 *  lock (para que la protección sea real bajo PgBouncer transaction mode —
 *  ver advisoryLock.ts); sin uno, usa el pool directo. */
export async function asegurarParticionesFuturas(ejecutor: Pool | PoolClient = pool): Promise<void> {
  await ejecutor.query("SELECT particiones_asegurar_futuras($1)", [env.particionesMesesAdelante]);
}

// Con más de una instancia del server, cada una tiene su propio setInterval
// — sin el lock, las dos llamarían a particiones_asegurar_futuras() en
// paralelo. La función SQL es idempotente (CREATE TABLE IF NOT EXISTS por
// partición) así que no hay riesgo de corrupción, pero sí de dos INSERTs
// en pg_class compitiendo por la misma partición nueva sin necesidad.
setInterval(() => {
  runSiPrimero(LOCK_IDS.particionado, (client) => asegurarParticionesFuturas(client)).catch((err) =>
    logger.error({ err }, "Error al asegurar las particiones futuras de checklists/ipercs")
  );
}, env.particionesCheckIntervalMs).unref();
