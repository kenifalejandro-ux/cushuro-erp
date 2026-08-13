/** src/server/shared/utils/idempotentBatch.ts
 *
 * La versión "de a muchos" de idempotentInsert.ts: hace que una operación
 * que crea N filas de un saque (hoy: las importaciones `/bulk`) se pueda
 * reintentar sin duplicar nada. Se apoya en la misma tabla
 * `idempotency_keys` (migración 0044).
 *
 * ── Por qué una clave por LOTE y no una por fila ─────────────────────────
 *
 * Porque la importación entera corre dentro de UNA transacción (la que
 * abre withTenant): o entran todas las filas o no entra ninguna. No existe
 * el estado parcial, así que un reintento solo puede encontrarse con "todo
 * hecho" o "nada hecho" -- que es exactamente lo que una clave por lote
 * distingue. Una clave por fila costaría N veces más y no protegería ni un
 * caso más.
 *
 * ── De dónde sale la clave, y por qué importa ────────────────────────────
 *
 * La manda el cliente en el header `Idempotency-Key`, y la DERIVA DEL
 * CONTENIDO del archivo (hash), no al azar. La diferencia es la que decide
 * si esto sirve o no: el reintento real no es "el sistema reintenta solo",
 * es una persona que ve el error, vuelve a apretar el botón y elige EL
 * MISMO ARCHIVO. Con una clave aleatoria eso genera una clave nueva y
 * duplica todo igual; derivándola del contenido, el mismo archivo produce
 * la misma clave y el segundo intento se reconoce como reintento.
 *
 * Va por header y no en el body a propósito: el body de `/bulk` es un
 * ARRAY crudo, y el middleware de cuota cuenta `req.body.length` para
 * saber cuántas filas se van a crear. Envolverlo en un objeto para hacerle
 * lugar a la clave haría que la cuota contara 1 en vez de N -- un agujero
 * por el que un tenant se pasaría de su límite.
 *
 * ── Sobre `fila_id` en NULL ──────────────────────────────────────────────
 *
 * Para un lote no hay UNA fila a la que apuntar, así que la clave queda con
 * `fila_id` NULL de forma permanente. Es la única excepción al comentario
 * de la migración 0044, que describe ese NULL como transitorio (cierto para
 * idempotentInsert, que crea una sola fila y después la enlaza).
 *
 * No genera ambigüedad con el otro helper: si por un choque imposible una
 * clave de lote llegara a idempotentInsert, éste ve `fila_id` NULL y
 * responde "ya procesado, nada que crear" -- nunca duplica, que es la
 * respuesta segura.
 *
 * ── Mismo contrato que idempotentInsert ──────────────────────────────────
 *
 * `client` TIENE que venir de un withTenant(): la reserva de la clave y la
 * creación de las filas deben commitear o revertir JUNTAS. Si la
 * importación falla, la clave se revierte con ella y un reintento legítimo
 * puede volver a intentarlo.
 */
import type { PoolClient } from "pg";

export interface ResultadoLoteIdempotente<T> {
  /** true = este lote YA se había procesado antes; no se creó nada ahora. */
  yaProcesado: boolean;
  /** Lo que devolvió `ejecutar`. `undefined` cuando `yaProcesado` es true:
   *  no se reconstruye el resultado original porque para un lote no hay una
   *  fila que recuperar, y afirmar un conteo viejo sería peor que no darlo
   *  -- quien llama debe decir "esto ya se importó" y dejar que el cliente
   *  recargue la lista, que es la verdad actual. */
  resultado?: T;
}

export interface OpcionesLoteIdempotente<T> {
  /** De un withTenant() -- ver el contrato de uso arriba. */
  client: PoolClient;
  /** Del contexto de autenticación, NUNCA del body ni del header. */
  tenantId: string;
  /** Un id del enum `modulo_erp`. */
  modulo: string;
  /** Header `Idempotency-Key`. `undefined` = el cliente no pidió
   *  idempotencia: se ejecuta directo, sin tocar idempotency_keys. */
  clienteUuid?: string;
  /** Hace el trabajo real (insertar las N filas). */
  ejecutar: () => Promise<T>;
}

export async function idempotentBatch<T>({
  client,
  tenantId,
  modulo,
  clienteUuid,
  ejecutar,
}: OpcionesLoteIdempotente<T>): Promise<ResultadoLoteIdempotente<T>> {
  if (!clienteUuid) {
    return { yaProcesado: false, resultado: await ejecutar() };
  }

  // ON CONFLICT DO NOTHING sobre la PK (tenant_id, modulo, cliente_uuid).
  // rowCount 0 = la clave ya existía ⇒ este lote ya se procesó.
  //
  // Dos requests concurrentes con la misma clave se serializan solos acá:
  // el segundo queda bloqueado en el índice único hasta que el primero
  // confirme o revierta. No hace falta ningún lock explícito.
  const reserva = await client.query(
    `INSERT INTO idempotency_keys (tenant_id, modulo, cliente_uuid)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, modulo, cliente_uuid) DO NOTHING`,
    [tenantId, modulo, clienteUuid]
  );

  if ((reserva.rowCount ?? 0) === 0) {
    return { yaProcesado: true };
  }

  return { yaProcesado: false, resultado: await ejecutar() };
}
