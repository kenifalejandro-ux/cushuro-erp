/** client/src/config/sentry.ts
 *
 * Monitoreo de errores del frontend. Es la contraparte de
 * src/server/config/sentry.ts y sigue sus mismas decisiones, para que el
 * comportamiento no dependa de qué mitad del sistema falló.
 *
 * Se importa como el PRIMER import de main.tsx: init() tiene que correr
 * antes de que React monte, o los errores de arranque no se capturan.
 *
 * VITE_SENTRY_DSN vacío (el default) = Sentry no se inicializa y todo
 * queda como no-op: la app funciona exactamente igual que sin este
 * archivo. Mismo criterio que el backend — apagado hasta que alguien lo
 * configure a propósito.
 *
 * OJO con el CSP: el DSN apunta a un dominio de Sentry, así que hay que
 * sumarlo a `connect-src` en la policy de helmet (src/server/app.ts) o el
 * navegador bloquea los reportes SIN avisar — no hay error visible, los
 * eventos simplemente nunca llegan.
 */
import * as Sentry from "@sentry/react";

import { filtrarEventoSentry } from "./sentryFilter";

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const habilitado = Boolean(dsn);

if (habilitado) {
  Sentry.init({
    dsn,
    environment:
      (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ?? import.meta.env.MODE,

    // Solo errores, sin performance tracing — misma decisión que el
    // backend: es un costo aparte que nadie pidió, y se puede subir de 0
    // más adelante si alguna vez hace falta medir latencias.
    tracesSampleRate: 0,

    // Nunca mandar IP ni cookies.
    sendDefaultPii: false,

    // SIN Session Replay, y no es un olvido: es la función más vendida de
    // Sentry en el frontend y la más peligrosa acá. Replay graba la
    // pantalla del usuario que tuvo el error — o sea, en un ERP
    // multi-tenant, los datos del tenant que lo tuvo, quedando visibles
    // para cualquiera con acceso al proyecto de Sentry. Eso rompería la
    // misma separación que el resto del sistema sostiene por RLS, y la
    // rompería por afuera de la base de datos, donde RLS no llega.
    // Si alguna vez se activa, tiene que ser con maskAllText y
    // blockAllMedia, y decidido a propósito.
    integrations: [],

    beforeSend: filtrarEventoSentry,
  });
}

/** Etiqueta los eventos con el tenant y el rol del usuario logueado.
 *
 *  Es solo para poder triagear ("¿esto le pasa a un tenant o a todos?")
 *  — se manda el slug y el rol, nunca datos del tenant. El id de usuario
 *  va como `id` de Sentry y no el email: alcanza para agrupar los errores
 *  de una misma persona sin mandar un dato personal a un tercero.
 *
 *  No-op si Sentry no está configurado, así que el caller puede llamarlo
 *  siempre sin chequear el flag. */
export function identificarUsuarioSentry(
  usuario: {
    id: string;
    tenantId: string;
    rol: string;
  } | null
): void {
  if (!habilitado) return;

  if (!usuario) {
    Sentry.setUser(null);
    Sentry.setTag("tenant", undefined);
    return;
  }

  Sentry.setUser({ id: usuario.id });
  Sentry.setTag("tenant", usuario.tenantId);
  Sentry.setTag("rol", usuario.rol);
}

/** Reporta un error a mano, para los lugares que no llegan al
 *  ErrorBoundary (un .catch() de una llamada de red, por ejemplo).
 *  No-op silencioso si Sentry no está configurado. */
export function capturarError(err: unknown, contexto?: Record<string, unknown>): void {
  if (!habilitado) return;
  Sentry.captureException(err, contexto ? { extra: contexto } : undefined);
}

export { Sentry };
