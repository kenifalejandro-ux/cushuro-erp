/** src/server/shared/utils/idempotencyKey.ts
 *
 * Leer la clave de idempotencia de un LOTE (ver idempotentBatch.ts) desde
 * el header `Idempotency-Key`. Extraído de documentos.controller.ts al
 * sumar carga masiva de Repuestos -- mismo contrato, sin cambio de
 * comportamiento, para no mantener dos copias idénticas del regex/parsing.
 */
import type { Request } from "express";

/** Formato UUID, sin exigir una versión concreta: la clave la deriva el
 *  cliente de un hash del contenido (ver DocumentosTable.tsx/
 *  RepuestosTable.tsx), no de crypto.randomUUID(), así que no es un UUID
 *  v4. Lo que importa es que entre en la columna `uuid` de
 *  idempotency_keys. */
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Una clave con formato inválido se IGNORA (undefined) en vez de
 *  rechazar el request -- perder una importación válida por un header
 *  mal armado es peor que procesarla sin protección contra duplicados. */
export function leerClaveIdempotencia(req: Request): string | undefined {
  const clave = req.get("Idempotency-Key");
  return clave && RE_UUID.test(clave) ? clave : undefined;
}
