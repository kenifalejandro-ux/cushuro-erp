/** src/server/config/sentry.ts
 *
 * Monitoreo de errores. Se importa como el PRIMER import de server.ts, antes
 * de bootstrap/app -- Sentry.init() necesita correr antes de que se
 * importen express/http/pg para poder instrumentarlos automáticamente.
 *
 * SENTRY_DSN vacío (el default) = Sentry no se inicializa y capturarError()
 * queda como no-op silencioso: la app funciona exactamente igual que sin
 * este archivo. Mismo criterio que el resto de la config opcional de
 * env.ts (APP_ENCRYPTION_KEY, PLATFORM_ADMIN_TOKEN) -- apagado hasta que
 * alguien lo configure a propósito.
 *
 * Cubre dos superficies distintas:
 *   1. Errores 5xx no controlados en requests HTTP -- vía
 *      Sentry.setupExpressErrorHandler(app) en app.ts. Solo captura >= 500
 *      por default (lee error.statusCode, que AppError ya expone) --  un
 *      404 "tenant no encontrado" es operación normal, no un incidente.
 *   2. Todo lo que NO pasa por ese middleware porque no hay ningún request
 *      HTTP de por medio: los workers periódicos (setInterval en
 *      platformBackup*.worker.ts, particionado.worker.ts, etc.) llaman a
 *      capturarError() a mano en su .catch(). uncaughtException y
 *      unhandledRejection a nivel de proceso los cubre el SDK solo (trae
 *      esas dos integraciones por default) -- no hace falta un
 *      process.on() propio acá.
 */
import * as Sentry from "@sentry/node";
import { env } from "./env";
import { sanitizeSensitiveFields } from "../shared/security/sanitizeLog";

const habilitado = Boolean(env.sentryDsn);

/** Separada de Sentry.init() para poder testearla sola, con un evento
 *  fabricado a mano, sin necesitar un DSN real ni red -- ver
 *  tests/sentry-config.test.ts. Reusa la MISMA lista de campos sensibles
 *  que ya usa el logger (sanitizeLog.ts) en vez de mantener una segunda
 *  lista de "qué es sensible" que se puede desincronizar de la real. */
export function filtrarEventoSentry<T>(event: T): T {
  return sanitizeSensitiveFields(event);
}

if (habilitado) {
  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.sentryEnvironment,
    // Solo errores por ahora, sin performance tracing -- es un costo y una
    // complejidad aparte que nadie pidió; se puede subir de 0 más adelante
    // si hace falta medir latencias, no es parte de "que nos avise si algo
    // falla".
    tracesSampleRate: 0,
    // Nunca mandar IP/cookies por default.
    sendDefaultPii: false,
    beforeSend: filtrarEventoSentry,
  });
}

/** Reporta un error inesperado a Sentry -- para los lugares que NO pasan
 *  por Sentry.setupExpressErrorHandler porque no hay un request HTTP de
 *  por medio (workers periódicos). No-op silencioso si Sentry no está
 *  configurado: se puede llamar siempre, sin chequear el flag en cada
 *  call site. */
export function capturarError(err: unknown, contexto?: Record<string, unknown>): void {
  if (!habilitado) return;
  Sentry.captureException(err, contexto ? { extra: contexto } : undefined);
}

export { Sentry };
