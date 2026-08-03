/** src/server/services/platformSession.service.ts
 *
 * Sesiones del panel de plataforma respaldadas en Redis — existen para que
 * el login por cookie (POST /sesion, POST /admin-sesion) sea revocable de
 * forma individual sin tener que rotar PLATFORM_ADMIN_TOKEN para todos, ni
 * esperar a que una cookie expire sola. El login por header
 * `Authorization: Bearer` (curl/integraciones) sigue siendo stateless: se
 * valida contra el token en cada request, sin sesión, igual que antes.
 *
 * A partir de las cuentas individuales de Platform Admin, la sesión guarda
 * un `actor` genérico — quién la abrió, no solo "con qué token": puede ser
 * un admin individual (`platform_admin`) o el secreto compartido en modo
 * de emergencia (`emergency_shared_secret`). Middleware y rutas leen ese
 * actor para completar la auditoría (ver platformAudit.service.ts) y para
 * decidir permisos (ver platformSuperAdmin.middleware.ts).
 *
 * Sin Redis no hay sesión revocable: crearSesion() devuelve null. Para el
 * secreto compartido, el caller (POST /sesion) cae al comportamiento
 * anterior (cookie = token crudo, sin revocación individual). Para admins
 * individuales no hay ese fallback — POST /admin-sesion responde 503 si no
 * hay Redis, porque no existe un equivalente razonable a "cookie = token
 * crudo" para una contraseña. Un error de Redis a mitad de camino tampoco
 * debe tirar abajo login/logout — se degrada, nunca lanza.
 */
import { randomUUID } from "crypto";
import { getRedis } from "../config/redis";
import { logger } from "../config/logger";
import { env } from "../config/env";

export const SESSION_COOKIE_PREFIX = "sid.";

export function idSesionDeCookie(valorCookie: string): string | null {
  return valorCookie.startsWith(SESSION_COOKIE_PREFIX) ? valorCookie.slice(SESSION_COOKIE_PREFIX.length) : null;
}

export function cookieDeSesion(sessionId: string): string {
  return `${SESSION_COOKIE_PREFIX}${sessionId}`;
}

export type ActorSesion =
  | { actorType: "platform_admin"; actorId: string; actorLabel: string }
  | { actorType: "emergency_shared_secret"; actorLabel: string };

export interface SesionPlataforma {
  ip: string;
  actor: ActorSesion;
  creadaEn: string;
}

function claveSesion(sessionId: string): string {
  return `platform-session:${sessionId}`;
}

function claveSesionesDeAdmin(adminId: string): string {
  return `platform-admin-sessions:${adminId}`;
}

export async function crearSesion(ip: string, actor: ActorSesion): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;

  try {
    const sessionId = randomUUID();
    const sesion: SesionPlataforma = { ip, actor, creadaEn: new Date().toISOString() };
    await redis.set(claveSesion(sessionId), JSON.stringify(sesion), "PX", env.platformSessionTtlMs);

    // Índice secundario: permite revocar TODAS las sesiones de un admin de
    // una sola vez al desactivarlo (cambiarEstadoPlatformAdminService) —
    // sin esto, desactivar a alguien no le cortaría el acceso hasta que su
    // cookie expire sola, inconsistente con cómo se corta el acceso de un
    // usuario/tenant en el resto de la app (ver revocarSesionesService).
    if (actor.actorType === "platform_admin") {
      const clave = claveSesionesDeAdmin(actor.actorId);
      await redis.sadd(clave, sessionId);
      await redis.pexpire(clave, env.platformSessionTtlMs);
    }

    return sessionId;
  } catch (err) {
    logger.warn({ err }, "No se pudo crear la sesión de plataforma en Redis, se usa el modo sin sesión");
    return null;
  }
}

/** null tanto si no hay Redis como si la sesión no existe o expiró — el
 *  middleware trata ambos casos igual: sin sesión válida, se rechaza. */
export async function obtenerSesion(sessionId: string): Promise<SesionPlataforma | null> {
  const redis = getRedis();
  if (!redis) return null;

  try {
    const crudo = await redis.get(claveSesion(sessionId));
    return crudo ? (JSON.parse(crudo) as SesionPlataforma) : null;
  } catch (err) {
    logger.warn({ err }, "No se pudo consultar la sesión de plataforma en Redis");
    return null;
  }
}

/** true si había una sesión y se borró. Nunca lanza: revocar es best-effort
 *  (la cookie del cliente se limpia igual desde el caller). */
export async function revocarSesion(sessionId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;

  try {
    const eliminadas = await redis.del(claveSesion(sessionId));
    return eliminadas > 0;
  } catch (err) {
    logger.warn({ err }, "No se pudo revocar la sesión de plataforma en Redis");
    return false;
  }
}

export interface SesionActiva {
  sessionId: string;
  ip: string;
  creadaEn: string;
}

/** Sesiones activas de un admin — la UI las lista para poder revocar una
 *  puntual (ej. "se me quedó abierta en la notebook del trabajo") sin
 *  desactivar la cuenta entera. [] tanto sin Redis como si no tiene
 *  ninguna; nunca lanza. No purga del índice las entradas ya vencidas que
 *  encuentre (expiraron solas, `obtenerSesion` ya las filtra al devolver
 *  null) — para no pisar una escritura concurrente de crearSesion(), se
 *  deja que el propio TTL del índice (ver crearSesion) las limpie. */
export async function listarSesionesDeAdmin(adminId: string): Promise<SesionActiva[]> {
  const redis = getRedis();
  if (!redis) return [];

  try {
    const sessionIds = await redis.smembers(claveSesionesDeAdmin(adminId));
    const sesiones = await Promise.all(
      sessionIds.map(async (sessionId) => {
        const sesion = await obtenerSesion(sessionId);
        return sesion ? { sessionId, ip: sesion.ip, creadaEn: sesion.creadaEn } : null;
      })
    );
    return sesiones.filter((s): s is SesionActiva => s !== null);
  } catch (err) {
    logger.warn({ err }, "No se pudo listar las sesiones del admin de plataforma");
    return [];
  }
}

/** Corta el acceso de un admin de inmediato (todas sus sesiones activas a
 *  la vez) — mismo criterio que revocarSesionesService para usuarios de
 *  tenant: desactivar a alguien no puede depender de que su cookie expire
 *  sola. Se llama desde cambiarEstadoPlatformAdminService al desactivar. */
export async function revocarSesionesDeAdmin(adminId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  try {
    const clave = claveSesionesDeAdmin(adminId);
    const sessionIds = await redis.smembers(clave);
    if (sessionIds.length > 0) {
      await redis.del(...sessionIds.map(claveSesion));
    }
    await redis.del(clave);
  } catch (err) {
    logger.warn({ err }, "No se pudo revocar las sesiones del admin de plataforma");
  }
}
