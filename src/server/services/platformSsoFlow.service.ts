/** src/server/services/platformSsoFlow.service.ts
 *
 * Estado transitorio del "baile" de Authorization Code entre que se
 * redirige al usuario al IdP y que vuelve al callback — necesita
 * sobrevivir esa ida y vuelta sin depender de una cookie de sesión propia
 * (todavía no hay sesión: es justamente lo que este flujo va a crear).
 * Se guarda en Redis, indexado por `state` (que además cumple su rol
 * habitual de anti-CSRF), con un TTL corto — más que suficiente para que
 * el usuario complete el login en el IdP, y acota cuánto puede vivir un
 * `state` filtrado o adivinado.
 *
 * tomarFlujo() borra la entrada al leerla: un `state` solo sirve una vez,
 * así un callback repetido (replay del navegador, doble click, o un
 * atacante reusando una URL de callback capturada) no revive un login ya
 * consumido.
 *
 * Sin Redis no hay SSO — no existe un fallback razonable a "sin sesión
 * revocable" acá como sí lo hay para el secreto compartido de plataforma:
 * el caller responde 503, mismo criterio que POST /admin-sesion sin Redis.
 */
import { randomUUID } from "crypto";
import { getRedis } from "../config/redis";
import { AppError } from "../shared/middlewares/error.middleware";

const TTL_MS = 5 * 60_000;

export type FlujoSso =
  | { contexto: "tenant"; tenantId: string; codeVerifier: string; nonce: string }
  | { contexto: "platform_admin"; codeVerifier: string; nonce: string };

function claveFlujo(state: string): string {
  return `sso-flow:${state}`;
}

export async function guardarFlujo(flujo: FlujoSso): Promise<string> {
  const redis = getRedis();
  if (!redis) throw new AppError(503, "SSO no disponible ahora mismo — intentá con tu contraseña");

  const state = randomUUID();
  await redis.set(claveFlujo(state), JSON.stringify(flujo), "PX", TTL_MS);
  return state;
}

export async function tomarFlujo(state: string): Promise<FlujoSso | null> {
  const redis = getRedis();
  if (!redis) return null;

  const clave = claveFlujo(state);
  const crudo = await redis.get(clave);
  if (!crudo) return null;

  await redis.del(clave);
  return JSON.parse(crudo) as FlujoSso;
}
