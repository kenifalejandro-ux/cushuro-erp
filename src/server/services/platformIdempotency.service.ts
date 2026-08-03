/** src/server/services/platformIdempotency.service.ts
 *
 * Idempotency-Key para POST /api/platform/tenants: sin esto, un doble-click
 * o un retry automático del cliente ante un timeout crea dos tenants por
 * el mismo pedido lógico — el único freno que había era el UNIQUE de slug,
 * que no ayuda si el retry no repite exactamente el mismo slug (o si el
 * request original sí llegó a la base pero la respuesta se perdió en el
 * camino).
 *
 * La fuente de verdad de "¿esta key ya se resolvió?" es platform_outbox
 * (Postgres, durable — ver platformOutbox.service.ts), no Redis: la
 * respuesta se escribe ahí DENTRO de la misma transacción que crea el
 * tenant (crearTenantConAdminService), así que sobrevive un crash del
 * proceso justo después del commit. Redis solo se usa acá para el gate de
 * concurrencia mientras la transacción todavía no confirmó — una ventana
 * corta (TTL_RESERVA_MS), y solo importa para evitar trabajo duplicado en
 * una carrera real entre dos requests simultáneos con la misma key nueva;
 * si Redis no está disponible, el header se ignora para ESE gate (se crea
 * el tenant igual) pero la garantía de "no duplicar por retry" sigue
 * intacta porque no depende de Redis.
 */
import { getRedis } from "../config/redis";
import { logger } from "../config/logger";
import { buscarRespuestaPorClave } from "./platformOutbox.service";

const TTL_RESERVA_MS = 2 * 60_000; // tiempo máximo que puede tardar crearTenantConAdminService

function claveReserva(idempotencyKey: string): string {
  return `platform-idempotency:crear-tenant:${idempotencyKey}`;
}

export type EstadoIdempotencia =
  | { estado: "nueva" }
  | { estado: "en_progreso" }
  | { estado: "resuelta"; respuesta: unknown };

/** 1) Postgres primero (platform_outbox): si ya hay una respuesta
 *  guardada, se devuelve tal cual, sin importar el estado de Redis. 2)
 *  Solo si no hay nada todavía, Redis decide si esta request es la
 *  primera en ver la key ("nueva", debe seguir y crear el tenant) o si ya
 *  hay otra en curso ("en_progreso", ver POST /tenants → 409). */
export async function consultarIdempotencia(idempotencyKey: string): Promise<EstadoIdempotencia> {
  const yaResuelta = await buscarRespuestaPorClave(idempotencyKey);
  if (yaResuelta !== null) return { estado: "resuelta", respuesta: yaResuelta };

  const redis = getRedis();
  if (!redis) return { estado: "nueva" };

  try {
    const reservado = await redis.set(
      claveReserva(idempotencyKey),
      JSON.stringify({ estado: "en_progreso" }),
      "PX",
      TTL_RESERVA_MS,
      "NX"
    );
    if (reservado === "OK") return { estado: "nueva" };

    // Ya reservada por otro request en curso — no vuelve a chequear
    // platform_outbox: si esa otra request ya hubiera terminado, la
    // habría liberado (liberarIdempotencia) o platform_outbox ya la
    // tendría (chequeado arriba). Tratarla como "en_progreso" es correcto.
    return { estado: "en_progreso" };
  } catch (err) {
    logger.warn({ err }, "No se pudo consultar Idempotency-Key en Redis, se ignora el gate de concurrencia");
    return { estado: "nueva" };
  }
}

/** Libera la reserva tras un error — sin esto, una Idempotency-Key que
 *  falló por un problema transitorio quedaría "en_progreso" hasta que
 *  venza TTL_RESERVA_MS, bloqueando reintentos legítimos mientras tanto. */
export async function liberarIdempotencia(idempotencyKey: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(claveReserva(idempotencyKey));
  } catch (err) {
    logger.warn({ err }, "No se pudo liberar la Idempotency-Key tras un error");
  }
}
