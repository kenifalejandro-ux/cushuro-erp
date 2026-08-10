/** src/server/services/realtimeEvents.service.ts
 *
 * Canal genérico de tiempo real: SSE del lado del navegador, Redis
 * pub/sub del lado del servidor. Dos piezas separadas a propósito:
 *
 * - `eventos_tiempo_real` / `platform_eventos_tiempo_real` (migración
 *   0042) son SOLO el buffer de reposición para un cliente que se
 *   reconecta con `Last-Event-ID` -- nunca el mecanismo de entrega en
 *   vivo. Se podan agresivo (ver eventosTiempoRealRetention.worker.ts).
 * - Redis pub/sub es el mecanismo de entrega en vivo, y el único motivo
 *   por el que esto funciona con más de una instancia del server
 *   corriendo a la vez (Railway): una mutación atendida por la instancia
 *   B tiene que llegarle a un cliente SSE conectado a la instancia A, y
 *   un EventEmitter en memoria de A nunca se entera de lo que publica B.
 *
 * Sin Redis configurado (getRedis() === null, ver config/redis.ts), esto
 * se degrada solo -- no hay entrega en vivo, pero el replay contra la
 * tabla sigue funcionando (mismo criterio que erpRateLimiter/authMiddleware:
 * Redis ausente reduce funcionalidad, no tira la app).
 *
 * Alcance de este ticket: el canal, la tabla buffer, la publicación, el
 * replay. Ningún módulo de negocio llama todavía a
 * publicarEventoTenant/publicarEventoPlataforma -- conectar el primer
 * emisor real es un paso aparte.
 */
import type { Redis } from "ioredis";
import { pool, withTenant } from "../config/database";
import { getRedis } from "../config/redis";
import { logger } from "../config/logger";

export interface EventoTiempoReal {
  id: string;
  tipo: string;
  payload: unknown;
}

const REPLAY_LIMIT = 500;

function canalTenant(tenantId: string): string {
  return `realtime:tenant:${tenantId}`;
}

const CANAL_PLATAFORMA = "realtime:platform";

// ═══════════════════════════════════════════════════════════════════════
// Publicación
// ═══════════════════════════════════════════════════════════════════════

/** Inserta en el buffer (su propia transacción con RLS, vía withTenant)
 *  y publica en Redis para entrega en vivo. El insert queda commiteado
 *  ANTES de publicar -- así un cliente que reconecta justo después de
 *  recibir el mensaje en vivo siempre encuentra la fila si necesita
 *  replay.
 *
 *  NUNCA lanza -- mismo criterio que registrarAuditoria() en
 *  platformAudit.service.ts: se llama después de que la mutación real ya
 *  se completó (los controllers la llaman igual que a registrarAuditoria,
 *  fuera de la transacción de negocio), así que un fallo acá no puede
 *  convertir una mutación exitosa en un 500 para el cliente. Devuelve
 *  `undefined` si no se pudo registrar -- quien llama no necesita
 *  reaccionar a eso, es best-effort. */
export async function publicarEventoTenant(
  tenantId: string,
  tipo: string,
  payload: unknown
): Promise<EventoTiempoReal | undefined> {
  try {
    const { rows } = await withTenant(tenantId, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO eventos_tiempo_real (tenant_id, tipo, payload) VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, tipo, JSON.stringify(payload)]
      )
    );
    const evento: EventoTiempoReal = { id: rows[0].id, tipo, payload };

    const redis = getRedis();
    if (redis) {
      try {
        await redis.publish(canalTenant(tenantId), JSON.stringify(evento));
      } catch (err) {
        logger.warn({ err, tenantId, tipo }, "No se pudo publicar evento de tenant en Redis");
      }
    }

    return evento;
  } catch (err) {
    logger.warn(
      { err, tenantId, tipo },
      "No se pudo registrar el evento en tiempo real (la mutación que lo originó no se ve afectada)"
    );
    return undefined;
  }
}

/** Mismo criterio de "nunca lanza" que publicarEventoTenant() -- ver ahí. */
export async function publicarEventoPlataforma(
  tipo: string,
  payload: unknown
): Promise<EventoTiempoReal | undefined> {
  try {
    return await publicarEventoPlataformaInterno(tipo, payload);
  } catch (err) {
    logger.warn(
      { err, tipo },
      "No se pudo registrar el evento de plataforma en tiempo real (la mutación que lo originó no se ve afectada)"
    );
    return undefined;
  }
}

async function publicarEventoPlataformaInterno(
  tipo: string,
  payload: unknown
): Promise<EventoTiempoReal> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO platform_eventos_tiempo_real (tipo, payload) VALUES ($1, $2) RETURNING id`,
    [tipo, JSON.stringify(payload)]
  );
  const evento: EventoTiempoReal = { id: rows[0].id, tipo, payload };

  const redis = getRedis();
  if (redis) {
    try {
      await redis.publish(CANAL_PLATAFORMA, JSON.stringify(evento));
    } catch (err) {
      logger.warn({ err, tipo }, "No se pudo publicar evento de plataforma en Redis");
    }
  }

  return evento;
}

// ═══════════════════════════════════════════════════════════════════════
// Replay (reposición al reconectar con Last-Event-ID)
// ═══════════════════════════════════════════════════════════════════════

export async function reponerEventosTenant(
  tenantId: string,
  desdeId: number
): Promise<EventoTiempoReal[]> {
  const { rows } = await withTenant(tenantId, (client) =>
    client.query<EventoTiempoReal>(
      `SELECT id, tipo, payload FROM eventos_tiempo_real
       WHERE id > $1 ORDER BY id ASC LIMIT $2`,
      [desdeId, REPLAY_LIMIT]
    )
  );
  return rows;
}

export async function reponerEventosPlataforma(desdeId: number): Promise<EventoTiempoReal[]> {
  const { rows } = await pool.query<EventoTiempoReal>(
    `SELECT id, tipo, payload FROM platform_eventos_tiempo_real
     WHERE id > $1 ORDER BY id ASC LIMIT $2`,
    [desdeId, REPLAY_LIMIT]
  );
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════
// Fan-out en vivo: un solo cliente Redis en modo SUBSCRIBE por instancia,
// con un broker en memoria que reparte cada mensaje a quien esté
// escuchando ese canal EN ESTA instancia (puede haber varios clientes SSE
// del mismo tenant conectados al mismo proceso).
//
// ioredis exige una conexión dedicada para SUBSCRIBE -- una vez que un
// cliente entra en modo suscripción deja de poder correr comandos
// normales (GET/SET/PUBLISH). Por eso getRedis() (comandos) y esto
// (suscripción) son conexiones separadas, vía .duplicate().
// ═══════════════════════════════════════════════════════════════════════

type OyenteCanal = (mensajeCrudo: string) => void;

let subscriber: Redis | null = null;
const oyentesPorCanal = new Map<string, Set<OyenteCanal>>();

function obtenerSubscriber(): Redis | null {
  const base = getRedis();
  if (!base) return null;

  if (!subscriber) {
    subscriber = base.duplicate();
    subscriber.on("message", (canal: string, mensaje: string) => {
      oyentesPorCanal.get(canal)?.forEach((oyente) => oyente(mensaje));
    });
    subscriber.on("error", (err: Error) => {
      logger.warn({ err }, "Error en la conexión Redis de suscripción a eventos en tiempo real");
    });
  }

  return subscriber;
}

/** Suscribe `onMensaje` al canal dado; devuelve la función de
 *  desuscripción (llamarla siempre al cerrar la conexión SSE, o el
 *  callback queda retenido en memoria para siempre). Sin Redis
 *  configurado, es un no-op que igual devuelve una función de limpieza
 *  válida -- el caller no necesita saber si Redis está disponible.
 *
 *  ASYNC a propósito: espera a que Redis confirme el SUBSCRIBE antes de
 *  devolver el control. La primera versión no lo esperaba ("fire and
 *  forget") -- un publish que corriera inmediatamente después de
 *  suscribirse (exactamente el caso de manejarConexionSSE, que se
 *  suscribe recién después del replay) podía perderse porque el comando
 *  SUBSCRIBE todavía no había llegado al server de Redis. Lo agarró un
 *  test de fan-out intermitente, no una revisión manual. */
export async function suscribirCanal(canal: string, onMensaje: OyenteCanal): Promise<() => void> {
  const redis = obtenerSubscriber();
  if (!redis) {
    logger.warn(
      { canal },
      "Redis no disponible: este cliente SSE no recibirá eventos en vivo, solo el replay inicial"
    );
    return () => {};
  }

  let oyentes = oyentesPorCanal.get(canal);
  if (!oyentes) {
    oyentes = new Set();
    oyentesPorCanal.set(canal, oyentes);
    try {
      await redis.subscribe(canal);
    } catch (err) {
      logger.warn({ err, canal }, "No se pudo suscribir al canal de Redis");
    }
  }
  oyentes.add(onMensaje);

  return () => {
    const activos = oyentesPorCanal.get(canal);
    if (!activos) return;
    activos.delete(onMensaje);
    if (activos.size === 0) {
      oyentesPorCanal.delete(canal);
      redis.unsubscribe(canal).catch(() => {});
    }
  };
}

export function canalDeTenant(tenantId: string): string {
  return canalTenant(tenantId);
}

export const CANAL_EVENTOS_PLATAFORMA = CANAL_PLATAFORMA;
