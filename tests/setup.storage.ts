/** tests/setup.storage.ts
 *
 * Corre en CADA archivo de test, antes que nada (setupFiles en
 * vitest.config.mts). Fuerza los drivers de storage a "local".
 *
 * ── Por qué existe ──────────────────────────────────────────────────────
 *
 * Los drivers se leen de `env` (que sale del .env de la máquina), así que
 * un desarrollador con R2 ya configurado —DOCUMENTOS_STORAGE_DRIVER=s3 y
 * credenciales reales, que es exactamente lo que hace falta para operar
 * producción— hacía que la suite subiera objetos de prueba AL BUCKET REAL
 * y que fallaran las aserciones que esperan un archivo en disco o un
 * stream en la respuesta (con s3 la descarga es un 302 a una URL firmada).
 * Pasó de verdad, con dos síntomas distintos en dos archivos distintos.
 *
 * El default seguro es local; los tests que SÍ ejercitan el camino s3
 * (tests/document-storage.test.ts, tests/platform-backup-s3.test.ts) lo
 * activan explícitamente ellos mismos, y siempre contra un mock del SDK
 * de S3 — nunca contra un bucket real.
 *
 * Nota: no alcanza con hacerlo en un beforeAll de cada archivo. Esto tiene
 * que ser el default de TODA la suite justamente porque el modo de fallo es
 * "alguien escribe un test nuevo y no se acuerda".
 */
import { env } from "../src/server/config/env";

env.documentosStorageDriver = "local";
env.backupStorageDriver = "local";
