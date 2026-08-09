/** src/server/services/platformOutbox.worker.ts
 *
 * Drena platform_outbox con un poll simple (setInterval) — a esta escala
 * (panel de administración, no un pipeline de eventos de alto tráfico) no
 * hace falta más que esto: nada de colas externas ni un scheduler aparte.
 * Se activa solo con importar este módulo (mismo criterio que el barrido
 * periódico de dedupe en platformAudit.service.ts) — se importa una vez
 * desde routes/platform.ts.
 *
 * Cada tipo de evento tiene su propio handler; si un handler tira, el
 * evento se reintenta en el próximo poll hasta MAX_INTENTOS (ver
 * platformOutbox.service.ts).
 */
import { getRedis } from "../config/redis";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { capturarError } from "../config/sentry";
import {
  reclamarPendientes,
  marcarProcesado,
  marcarFallo,
  type EventoOutbox,
  type TipoEventoOutbox,
} from "./platformOutbox.service";

type Handler = (evento: EventoOutbox) => Promise<void>;

const handlers: Record<TipoEventoOutbox, Handler> = {
  // Puebla el cache de Redis para que el próximo intento con la misma
  // Idempotency-Key sea instantáneo (un GET a Redis en vez de una query a
  // Postgres) — NO es la fuente de verdad: esa es platform_outbox, leída
  // directo en consultarIdempotencia. Si esto nunca corre (Redis caído de
  // punta a punta), la corrección no se ve afectada, solo el rendimiento
  // del camino de retry.
  idempotency_response: async (evento) => {
    const redis = getRedis();
    if (!redis) return; // nada que hacer sin Redis — no es un fallo, reintentar no cambiaría nada
    await redis.set(
      `platform-idempotency:crear-tenant:${evento.clave}`,
      JSON.stringify({ estado: "resuelta", respuesta: evento.payload }),
      "PX",
      24 * 60 * 60_000
    );
  },
  // Stub a propósito: hoy solo deja rastro estructurado en el log. El
  // punto de extensión para un webhook/Slack real es este handler — el
  // resto del pipeline (escritura transaccional del evento, reintentos
  // con backoff vía intentos/MAX_INTENTOS) ya está listo, no hace falta
  // tocar nada más que el cuerpo de esta función.
  alerta_rafaga: async (evento) => {
    logger.warn({ payload: evento.payload }, "Alerta de plataforma: ráfaga detectada");
  },
};

/** Exportado aparte de la lógica de arranque para que los tests puedan
 *  llamarlo directo (determinista) en vez de esperar al setInterval. */
export async function drenarUnaVez(): Promise<void> {
  const pendientes = await reclamarPendientes(20);
  for (const evento of pendientes) {
    const handler = handlers[evento.tipo];
    if (!handler) {
      logger.warn(
        { tipo: evento.tipo },
        "Evento de outbox sin handler registrado, se deja pendiente"
      );
      continue;
    }
    try {
      await handler(evento);
      await marcarProcesado(evento.id);
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err, evento: evento.id, tipo: evento.tipo },
        "Falló el handler de un evento de outbox"
      );
      await marcarFallo(evento.id, evento.intentos, mensaje, evento.tipo);
    }
  }
}

setInterval(() => {
  drenarUnaVez().catch((err) => {
    logger.warn({ err }, "Error inesperado drenando platform_outbox");
    capturarError(err, { worker: "platformOutbox" });
  });
}, env.platformOutboxPollIntervalMs).unref();
