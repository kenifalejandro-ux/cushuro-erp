/** client/src/config/sentryFilter.ts
 *
 * Filtro que corre sobre CADA evento antes de que salga hacia Sentry.
 *
 * Está separado de sentry.ts a propósito, igual que en el backend
 * (src/server/config/sentry.ts separa filtrarEventoSentry de Sentry.init):
 * este archivo no toca `import.meta.env` ni el SDK, así que es una función
 * pura que se puede testear sola, sin navegador, sin DSN y sin red — ver
 * tests/sentry-frontend-filter.test.ts.
 *
 * Duplica la lógica de src/server/shared/security/sanitizeLog.ts en vez de
 * importarla porque client/ es un paquete aparte: su tsconfig declara
 * `include: ["src"]`, así que no alcanza nada fuera de client/src. La
 * regex se mantiene idéntica a propósito — si se agrega un campo sensible
 * nuevo, hay que tocarlo en los dos lados.
 */

const PATRON_CAMPO_SENSIBLE = /password|token|authorization|secret|creditcard|credit_card/i;
const CENSURA = "[redacted]";

/** Censura por NOMBRE de campo a cualquier profundidad, sin necesitar
 *  conocer la ruta exacta de antemano — un evento de Sentry anida los datos
 *  en formas que cambian según de dónde salió el error (request, breadcrumb,
 *  contexto extra), así que buscar por ruta fija dejaría huecos. */
export function censurarCamposSensibles<T>(valor: T, vistos: WeakSet<object> = new WeakSet()): T {
  if (valor === null || typeof valor !== "object") {
    return valor;
  }

  if (vistos.has(valor as object)) {
    // Referencia circular: los eventos de Sentry las tienen seguido (un
    // error cuyo `cause` apunta de vuelta a sí mismo, o un nodo del DOM en
    // un breadcrumb). Sin esto, el filtro entraría en loop infinito y
    // colgaría la pestaña del usuario — peor que el error que se reporta.
    return valor;
  }
  vistos.add(valor as object);

  if (Array.isArray(valor)) {
    return valor.map((item) => censurarCamposSensibles(item, vistos)) as unknown as T;
  }

  const resultado: Record<string, unknown> = {};
  for (const [clave, val] of Object.entries(valor as Record<string, unknown>)) {
    resultado[clave] = PATRON_CAMPO_SENSIBLE.test(clave)
      ? CENSURA
      : censurarCamposSensibles(val, vistos);
  }
  return resultado as T;
}

/** Lo que Sentry recibe como `beforeSend`.
 *
 *  Además de censurar campos sensibles, borra el cuerpo del request. En un
 *  ERP multi-tenant ese cuerpo es el peligro real: no son credenciales
 *  —esas ya las agarra la regex— sino datos de negocio del tenant que tuvo
 *  el error (un lote de repuestos, un checklist, una lectura de
 *  combustible) que terminarían visibles en el proyecto de Sentry para
 *  cualquiera que tenga acceso, incluido quien no debería ver datos de
 *  clientes. Para diagnosticar alcanza con saber QUÉ request falló, no con
 *  qué payload. */
export function filtrarEventoSentry<T extends { request?: { data?: unknown } }>(evento: T): T {
  const limpio = censurarCamposSensibles(evento);
  if (limpio?.request && "data" in limpio.request) {
    delete limpio.request.data;
  }
  return limpio;
}
