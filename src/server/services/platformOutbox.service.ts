/** src/server/services/platformOutbox.service.ts
 *
 * Outbox transaccional (migrations/0018_platform_outbox.sql,
 * 0024_platform_outbox_backoff.sql): un evento que necesita un efecto en
 * OTRO sistema (Redis, un webhook futuro) se escribe acá DENTRO de la
 * misma transacción que el cambio de negocio que lo origina — nunca con
 * `pool` solo, siempre con el `client` de esa transacción en curso (ver
 * escribirEventoOutbox). Así el evento nunca queda "fantasma": si la
 * transacción se revierte, el evento tampoco existió nunca.
 *
 * platformOutbox.worker.ts es quien drena estos eventos y les aplica su
 * efecto — este archivo solo escribe/lee la tabla.
 */
import type { Pool, PoolClient } from "pg";
import { pool } from "../config/database";

export type TipoEventoOutbox = "idempotency_response" | "alerta_rafaga";

export interface EventoOutbox {
  id: string;
  tipo: TipoEventoOutbox;
  clave: string | null;
  payload: unknown;
  estado: "pendiente" | "procesado" | "fallido";
  intentos: number;
  creadoEn: string;
}

/** `db` es el `client` de la transacción en curso — pasar `pool` acá
 *  rompería la garantía de atomicidad que es el punto entero del outbox. */
export async function escribirEventoOutbox(
  db: Pool | PoolClient,
  evento: { tipo: TipoEventoOutbox; clave?: string | null; payload: unknown }
): Promise<void> {
  await db.query(`INSERT INTO platform_outbox (tipo, clave, payload) VALUES ($1, $2, $3)`, [
    evento.tipo,
    evento.clave ?? null,
    JSON.stringify(evento.payload),
  ]);
}

/** Lectura directa fuera de cualquier transacción — platform_outbox es la
 *  fuente de verdad durable para "¿esta Idempotency-Key ya se resolvió?",
 *  independiente de si el worker ya llegó a poblar el cache de Redis o no
 *  (ver platformIdempotency.service.ts). null si no hay ningún evento
 *  'idempotency_response' con esa clave todavía. */
export async function buscarRespuestaPorClave(clave: string): Promise<unknown | null> {
  const result = await pool.query(
    `SELECT payload FROM platform_outbox WHERE tipo = 'idempotency_response' AND clave = $1 LIMIT 1`,
    [clave]
  );
  return result.rows[0]?.payload ?? null;
}

const LEASE_MS = 30_000; // cuánto puede tardar un handler antes de que otra instancia pueda reclamar el mismo evento

/** Reclama un lote de eventos listos para procesar y les pone un "lease": empuja
 *  disponible_en LEASE_MS hacia el futuro ANTES de devolverlos, así que si el
 *  proceso muere a mitad de un handler el evento no queda huérfano para siempre
 *  (vuelve a estar disponible cuando el lease expira) ni lo reclama otra
 *  instancia del worker mientras tanto. FOR UPDATE SKIP LOCKED (dentro del
 *  UPDATE ... FROM) es lo que hace seguro correr esto en paralelo desde más de
 *  una instancia: dos workers reclamando al mismo tiempo nunca se devuelven las
 *  mismas filas, y ninguno espera bloqueado por el otro. Es una sola sentencia
 *  (autocommit) a propósito — nada de retener una transacción abierta mientras
 *  el handler hace I/O externo (Redis, un webhook futuro). */
export async function reclamarPendientes(limit: number): Promise<EventoOutbox[]> {
  const result = await pool.query(
    `UPDATE platform_outbox
     SET disponible_en = now() + make_interval(secs => $1)
     FROM (
       SELECT id FROM platform_outbox
       WHERE estado = 'pendiente' AND disponible_en <= now()
       ORDER BY creado_en
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     ) reclamados
     WHERE platform_outbox.id = reclamados.id
     RETURNING platform_outbox.id, platform_outbox.tipo, platform_outbox.clave,
               platform_outbox.payload, platform_outbox.estado, platform_outbox.intentos,
               platform_outbox.creado_en AS "creadoEn"`,
    [LEASE_MS / 1000, limit]
  );
  return result.rows;
}

export async function marcarProcesado(id: string): Promise<void> {
  await pool.query(
    `UPDATE platform_outbox SET estado = 'procesado', procesado_en = now() WHERE id = $1`,
    [id]
  );
}

const MAX_INTENTOS = 5;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/** Backoff exponencial simple con techo — 2s, 4s, 8s, 16s, 32s (techado a
 *  5 min si MAX_INTENTOS creciera). Evita que un evento que falla por algo
 *  transitorio (Redis caído un momento) se reintente en cada poll sin
 *  ninguna espera creciente. */
function calcularBackoffMs(intentos: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** intentos, BACKOFF_MAX_MS);
}

/** Tras MAX_INTENTOS fallidos pasa a 'fallido' y el worker deja de
 *  reintentarlo — evita reintentar para siempre algo que nunca va a
 *  funcionar (ej. Redis caído de forma permanente) y ensuciar los logs
 *  cada PLATFORM_OUTBOX_POLL_INTERVAL_MS. `error` queda en ultimo_error
 *  para poder diagnosticar un evento 'fallido' sin ir a buscar logs viejos. */
export async function marcarFallo(
  id: string,
  intentosActuales: number,
  error: string
): Promise<void> {
  const intentos = intentosActuales + 1;
  const agotado = intentos >= MAX_INTENTOS;
  const backoffSegundos = calcularBackoffMs(intentos) / 1000;
  await pool.query(
    `UPDATE platform_outbox
     SET estado = $1, intentos = $2, ultimo_error = $3,
         disponible_en = now() + make_interval(secs => $4)
     WHERE id = $5`,
    [agotado ? "fallido" : "pendiente", intentos, error.slice(0, 2000), backoffSegundos, id]
  );
}
