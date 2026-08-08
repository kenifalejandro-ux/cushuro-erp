/** src/server/services/platformBackupWriteDrill.worker.ts
 *
 * Restore drill de ESCRITURA: a diferencia de platformBackupDrill.worker.ts
 * (que solo lee, descifra y compara el manifiesto), esto ejercita el camino
 * real de escritura — vaciarDatosDeTenant() + restaurarTablas(), las mismas
 * funciones que usa restaurarBackupService() en un restore de verdad —
 * insertando el backup más reciente completo (de cualquier tenant) sobre un
 * tenant descartable creado para esta corrida.
 *
 * "Descartable" acá es una FILA TEMPORAL en `tenants`, no un schema aparte:
 * este sistema aísla por RLS de fila (tenant_id + current_setting('app.
 * tenant_id')), no por schema-per-tenant. Ver database.ts / withTenant().
 *
 * ── Por qué nunca hace COMMIT ────────────────────────────────────────────
 *
 * Todo el drill —crear el tenant temporal, vaciar (no-op sobre un tenant
 * recién creado), restaurar, comparar conteos— corre dentro de UNA sola
 * transacción que SIEMPRE termina en ROLLBACK, incluso cuando todo salió
 * bien (ver runSiPrimero(..., { siempreRollback: true })). Es más fuerte
 * que "insertar y borrar en un finally": si el proceso crashea a mitad de
 * camino, una transacción sin COMMIT se aborta sola al cerrarse la
 * conexión — no puede quedar un tenant huérfano ni una fila de negocio de
 * prueba en producción bajo ningún escenario, ni siquiera un crash.
 *
 * Por el mismo motivo, este worker NUNCA restaura sobre un tenant real: el
 * target es siempre el UUID que este mismo drill génera unas líneas antes
 * de usarlo, jamás un id que venga de otro lado.
 *
 * Apagado por default (BACKUP_WRITE_DRILL_ENABLED) — a diferencia del
 * drill de lectura, este sí escribe en Postgres de producción (aunque
 * termine en rollback), así que activarlo es una decisión explícita.
 */
import { randomUUID } from "crypto";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { leerBackup, type DriverStorage } from "./platformBackupStorage";
import {
  vaciarDatosDeTenant,
  restaurarTablas,
  type ContenidoBackup,
} from "./platformBackup.service";
import { runSiPrimero, LOCK_IDS } from "../shared/utils/advisoryLock";
import { capturarError } from "../config/sentry";

export interface ResultadoDrillEscritura {
  backupId: string;
  tenantOriginalId: string;
  tenantDrillId: string;
  ok: boolean;
  /** Tablas donde la cantidad de filas insertadas no coincide con el
   *  manifiesto guardado en tenant_backups.tablas. Vacío si `ok` es true. */
  discrepancias: string[];
  /** Presente si el drill ni siquiera llegó a comparar conteos (falló la
   *  lectura, el parseo, o algún INSERT). */
  error?: string;
}

interface FilaBackupParaDrill {
  id: string;
  tenant_id: string;
  storage: DriverStorage;
  storage_key: string;
  tablas: Record<string, number>;
}

/** Corre el drill de escritura contra el backup COMPLETO más reciente
 *  (de cualquier tenant). Solo uno por corrida, a propósito: el objetivo es
 *  probar que el CAMINO de escritura funciona, no volver a certificar cada
 *  backup individual (eso ya lo hace el drill de lectura, que sí itera por
 *  tenant). Devuelve `null` si todavía no hay ningún backup completo. */
export async function correrRestoreDrillEscritura(opciones?: {
  habilitado?: boolean;
}): Promise<ResultadoDrillEscritura | null> {
  const habilitado = opciones?.habilitado ?? env.backupWriteDrillEnabled;
  if (!habilitado) return null;

  const resultado = await runSiPrimero(
    LOCK_IDS.backupWriteDrill,
    async (client) => {
      const backupRow = await client.query<FilaBackupParaDrill>(
        `SELECT id, tenant_id, storage, storage_key, tablas
         FROM tenant_backups
         WHERE estado = 'completo'
         ORDER BY creado_en DESC
         LIMIT 1`
      );
      if (backupRow.rows.length === 0) return null;

      const fila = backupRow.rows[0];
      const ubicacion = { storage: fila.storage, key: fila.storage_key };

      // Tenant descartable: fila nueva en `tenants` (sin RLS — ver
      // helpers.ts), nombre/slug marcados como drill y con un UUID propio
      // para que, si alguna vez algo de esto sobreviviera por error, sea
      // imposible confundirlo con un tenant real.
      const tenantDrillId = randomUUID();
      const marcaDrill = `__drill__${tenantDrillId}`;
      await client.query(`INSERT INTO tenants (id, nombre, slug) VALUES ($1, $2, $3)`, [
        tenantDrillId,
        marcaDrill,
        marcaDrill,
      ]);

      // vaciarDatosDeTenant/restaurarTablas operan sobre tablas con RLS:
      // necesitan app.tenant_id seteado en ESTA transacción, igual que
      // hace withTenant() para un restore real (acá no podemos usar
      // withTenant() porque abre su propia conexión/transacción y comitea
      // sola — ver advisoryLock.ts sobre por qué).
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantDrillId]);

      try {
        const crudo = await leerBackup(ubicacion);
        const backup = JSON.parse(crudo) as ContenidoBackup;

        // Nunca es el mismo tenant que originó el backup (tenantDrillId es
        // siempre nuevo), así que remapearIds va SIEMPRE en true — mismo
        // criterio que un restore real hacia un tenant distinto (clonar).
        await vaciarDatosDeTenant(client, tenantDrillId); // no-op: el tenant es nuevo, pero ejercita el mismo camino que un restore real
        const tablasRestauradas = await restaurarTablas(client, backup, tenantDrillId, true);

        const discrepancias = Object.entries(fila.tablas)
          .filter(
            ([tabla, cantidadEsperada]) => (tablasRestauradas[tabla] ?? -1) !== cantidadEsperada
          )
          .map(([tabla]) => tabla);

        const ok = discrepancias.length === 0;
        const resultado: ResultadoDrillEscritura = {
          backupId: fila.id,
          tenantOriginalId: fila.tenant_id,
          tenantDrillId,
          ok,
          discrepancias,
        };

        // Se loguea ACÁ, antes de volver — el ROLLBACK que viene después
        // no afecta lo ya logueado, solo lo que se escribió en Postgres.
        if (ok) {
          logger.info(
            { backupId: fila.id, tenantDrillId },
            "Restore drill de escritura: backup restaurado y verificado OK — rollback ejecutado con éxito, sin cambios persistidos"
          );
        } else {
          logger.error(
            { backupId: fila.id, tenantDrillId, discrepancias },
            "Restore drill de escritura: el backup restaurado no coincide con su manifiesto — rollback ejecutado con éxito, sin cambios persistidos"
          );
        }

        return resultado;
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : String(err);
        logger.error(
          { err, backupId: fila.id, tenantDrillId },
          "Restore drill de escritura: falló antes de completar la verificación — rollback ejecutado con éxito, sin cambios persistidos"
        );
        return {
          backupId: fila.id,
          tenantOriginalId: fila.tenant_id,
          tenantDrillId,
          ok: false,
          discrepancias: [],
          error: mensaje,
        } satisfies ResultadoDrillEscritura;
      }
    },
    { siempreRollback: true }
  );

  return resultado ?? null;
}

setInterval(() => {
  correrRestoreDrillEscritura().catch((err) => {
    logger.error({ err }, "Error inesperado en el restore drill de escritura");
    capturarError(err, { worker: "platformBackupWriteDrill" });
  });
}, env.backupWriteDrillCheckIntervalMs).unref();
