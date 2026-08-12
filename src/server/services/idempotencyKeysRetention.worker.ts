/** src/server/services/idempotencyKeysRetention.worker.ts
 *
 * Borra las claves de idempotencia vencidas (`idempotency_keys`, migración
 * 0044). Sin esto la tabla crece una fila por cada checklist/IPERC creado
 * desde un dispositivo, para siempre — y la protección que dan esas filas
 * caduca a las 72h de todos modos.
 *
 * Este worker NO decide cuánto vive una clave: eso lo fija `expires_at` al
 * insertarla (72h por default, ver el porqué de ese número en la
 * migración). Acá solo se barre lo que ya venció. La consecuencia práctica
 * es que cambiar la ventana es cambiar el DEFAULT de la columna, no este
 * archivo — y las claves viejas siguen honrando la ventana con la que
 * nacieron.
 *
 * ── Por qué tenant por tenant y no un DELETE global ─────────────────────
 *
 * `idempotency_keys` tiene RLS FORZADO y su policy es
 * `tenant_id = current_setting('app.tenant_id')::uuid` sin `missing_ok`.
 * Un `pool.query("DELETE FROM idempotency_keys WHERE expires_at < now()")`
 * directo NO borra de más ni de menos: revienta con
 * `invalid input syntax for type uuid: ""`. Es exactamente la trampa que
 * ya se cayó en la primera versión de eventosTiempoRealRetention.worker.ts
 * — misma forma, misma solución: iterar `tenants` (que no tiene RLS) y
 * hacer el DELETE de cada uno dentro de una transacción con su
 * `app.tenant_id` seteado.
 *
 * Mismo patrón de lock POR LOTE que ese worker (ver advisoryLock.ts sobre
 * por qué el lock no puede envolver toda la corrida).
 */
import type { PoolClient } from "pg";
import { pool, withTenant } from "../config/database";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { runSiPrimero, LOCK_IDS } from "../shared/utils/advisoryLock";
import { capturarError } from "../config/sentry";

const LOTE = 5000;

/** `client` ya tiene que estar en una transacción con `app.tenant_id`
 *  seteado para `tenantId` — acá solo se hace el DELETE. */
async function borrarLoteVencidas(client: PoolClient, tenantId: string): Promise<number> {
  const result = await client.query(
    `DELETE FROM idempotency_keys
     WHERE (tenant_id, modulo, cliente_uuid) IN (
       SELECT tenant_id, modulo, cliente_uuid FROM idempotency_keys
       WHERE tenant_id = $1 AND expires_at < now()
       LIMIT $2
     )`,
    [tenantId, LOTE]
  );
  return result.rowCount ?? 0;
}

/** tenants no tiene RLS (ver ALLOWLIST_SIN_RLS en rls-coverage.test.ts) —
 *  pool.query directo es seguro acá. */
async function idsDeTenants(): Promise<string[]> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM tenants`);
  return result.rows.map((fila) => fila.id);
}

function logSiHuboBorrados(total: number): void {
  if (total > 0) {
    logger.info(
      { tabla: "idempotency_keys", filasBorradas: total },
      "Retención de idempotency_keys: claves vencidas borradas"
    );
  }
}

/** Uso directo, sin coordinación entre instancias — para tests y una
 *  corrida manual. */
export async function limpiarIdempotencyKeysVencidas(): Promise<{ filasBorradas: number }> {
  let total = 0;
  for (const tenantId of await idsDeTenants()) {
    for (;;) {
      const borradas = await withTenant(tenantId, (client) => borrarLoteVencidas(client, tenantId));
      total += borradas;
      if (borradas < LOTE) break;
    }
  }
  logSiHuboBorrados(total);
  return { filasBorradas: total };
}

/** Uso del worker periódico: lock por lote, no uno solo para toda la
 *  corrida — ver el comentario del archivo. */
async function correrRetencionCoordinada(): Promise<void> {
  let total = 0;
  for (const tenantId of await idsDeTenants()) {
    for (;;) {
      const borradas = await runSiPrimero(LOCK_IDS.idempotencyKeysRetention, async (client) => {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        return borrarLoteVencidas(client, tenantId);
      });
      if (borradas === undefined) break; // el lock de este lote ya lo tiene otra instancia
      total += borradas;
      if (borradas < LOTE) break;
    }
  }
  logSiHuboBorrados(total);
}

setInterval(() => {
  correrRetencionCoordinada().catch((err) => {
    logger.warn({ err }, "Error inesperado en la retención de idempotency_keys");
    capturarError(err, { worker: "idempotencyKeysRetention" });
  });
}, env.idempotencyKeysRetentionCheckIntervalMs).unref();
