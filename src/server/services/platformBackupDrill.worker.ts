/** src/server/services/platformBackupDrill.worker.ts
 *
 * Restore drill BÁSICO: valida periódicamente que el backup COMPLETO más
 * reciente de cada tenant, y el más reciente de plataforma, todavía se
 * puedan leer y descifrar, y que las filas que contienen coincidan con el
 * manifiesto de conteo guardado en tenant_backups.tablas /
 * platform_backups.tablas al momento de crearlo (ver platformBackup.
 * service.ts y platformBackupPlataforma.service.ts).
 *
 * Un backup nunca restaurado no es una garantía, es una suposición — esto
 * convierte esa suposición en algo que se verifica solo, sin depender de
 * que alguien se acuerde de probarlo a mano justo antes de necesitarlo de
 * verdad (que es cuando ya es tarde para descubrir que estaba corrupto).
 *
 * ── Por qué "básico" y no un restore de verdad ───────────────────────────
 *
 * La versión completa restauraría el backup sobre un esquema/tenant
 * descartable dentro de la misma base, contaría filas insertadas de
 * verdad, y lo borraría — prueba el camino real de restaurarBackupService()
 * en vez de solo el archivo. Se dejó deliberadamente afuera de esta
 * primera pasada: usa recursos de la base de PRODUCCIÓN para el ensayo, y
 * agrega superficie de riesgo (un ensayo que falla a mitad de camino tiene
 * que limpiar bien lo que alcanzó a insertar). Este chequeo, en cambio, es
 * de solo lectura de punta a punta — nunca toca Postgres más que para leer
 * el índice de backups — y ya responde la pregunta que más importa: "¿el
 * objeto que tenemos guardado todavía es legible y está completo?". Un
 * backup ilegible o con menos filas de las que dice tener es indistinguible
 * de no tener backup, y eso sí hay que saberlo antes de un incidente, no
 * durante.
 */
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { leerBackup, type DriverStorage } from "./platformBackupStorage";
import { runSiPrimero, LOCK_IDS } from "../shared/utils/advisoryLock";

export interface ResultadoDrillBackup {
  backupId: string;
  ok: boolean;
  /** Tablas del manifiesto cuya cantidad de filas en el archivo no
   *  coincide con lo que tenant_backups/platform_backups dice que tiene
   *  (incluye las que faltan del todo). Vacío si `ok` es true. */
  discrepancias: string[];
  /** Presente si el backup ni siquiera se pudo leer/descifrar/parsear —
   *  en ese caso `discrepancias` queda vacío porque no hay con qué comparar. */
  error?: string;
}

/** Los dos formatos de contenido (ContenidoBackup en platformBackup.service.ts
 *  y ContenidoBackupPlataforma en platformBackupPlataforma.service.ts) no
 *  se exportan — no hace falta el resto de sus campos acá, solo esta forma
 *  en común. */
interface ContenidoConTablas {
  tablas?: Record<string, unknown[]>;
}

async function verificarUnBackup(
  backupId: string,
  ubicacion: { storage: DriverStorage; key: string },
  manifiesto: Record<string, number>
): Promise<ResultadoDrillBackup> {
  try {
    const crudo = await leerBackup(ubicacion);
    const contenido: ContenidoConTablas = JSON.parse(crudo);

    if (!contenido.tablas || typeof contenido.tablas !== "object") {
      return { backupId, ok: false, discrepancias: [], error: "El backup no tiene la forma esperada (falta 'tablas')" };
    }

    const discrepancias = Object.entries(manifiesto)
      .filter(([tabla, cantidadEsperada]) => {
        const filas = contenido.tablas![tabla];
        return (Array.isArray(filas) ? filas.length : -1) !== cantidadEsperada;
      })
      .map(([tabla]) => tabla);

    return { backupId, ok: discrepancias.length === 0, discrepancias };
  } catch (err) {
    // Cubre lectura del storage, descifrado y JSON.parse — cualquiera de
    // los tres significa lo mismo para este chequeo: el backup no sirve
    // hoy, sin importar por qué.
    return { backupId, ok: false, discrepancias: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ResumenDrill {
  tenants: ResultadoDrillBackup[];
  plataforma: ResultadoDrillBackup | null;
}

interface FilaBackupParaDrill {
  id: string;
  storage: DriverStorage;
  storage_key: string;
  tablas: Record<string, number>;
}

/** Corre el drill contra el backup COMPLETO más reciente de cada tenant y
 *  el más reciente de plataforma. Nunca escribe ni restaura nada — el
 *  único costo es leer cada objeto de storage una vez. */
export async function correrRestoreDrill(): Promise<ResumenDrill> {
  const tenantRows = await pool.query<FilaBackupParaDrill>(
    `SELECT DISTINCT ON (tenant_id) id, storage, storage_key, tablas
     FROM tenant_backups
     WHERE estado = 'completo'
     ORDER BY tenant_id, creado_en DESC`
  );

  const tenants = await Promise.all(
    tenantRows.rows.map((fila) => verificarUnBackup(fila.id, { storage: fila.storage, key: fila.storage_key }, fila.tablas))
  );

  const plataformaRows = await pool.query<FilaBackupParaDrill>(
    `SELECT id, storage, storage_key, tablas FROM platform_backups WHERE estado = 'completo' ORDER BY creado_en DESC LIMIT 1`
  );
  const plataforma =
    plataformaRows.rows.length > 0
      ? await verificarUnBackup(
          plataformaRows.rows[0].id,
          { storage: plataformaRows.rows[0].storage, key: plataformaRows.rows[0].storage_key },
          plataformaRows.rows[0].tablas
        )
      : null;

  const fallidos = [...tenants, ...(plataforma ? [plataforma] : [])].filter((r) => !r.ok);
  if (fallidos.length > 0) {
    // Se listan uno por uno: esto es justo lo que alguien necesita ver de
    // entrada si entra a mirar logs después de un incidente, no algo que
    // deba ir a buscar aparte.
    logger.error({ fallidos }, "Restore drill: uno o más backups recientes no pasaron la verificación");
  } else if (tenants.length > 0 || plataforma) {
    logger.info(
      { verificados: tenants.length + (plataforma ? 1 : 0) },
      "Restore drill: todos los backups recientes verificados OK"
    );
  }

  return { tenants, plataforma };
}

setInterval(() => {
  runSiPrimero(LOCK_IDS.backupDrill, correrRestoreDrill).catch((err) =>
    logger.error({ err }, "Error inesperado en el restore drill")
  );
}, env.backupDrillCheckIntervalMs).unref();
