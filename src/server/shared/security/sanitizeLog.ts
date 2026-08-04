/** src/server/shared/security/sanitizeLog.ts
 *
 * Enmascara campos sensibles en cualquier profundidad de un objeto antes
 * de que el logger lo serialice — a diferencia de `redact.paths` de pino
 * (que exige conocer de antemano la ruta exacta, p. ej. "req.headers.
 * authorization"), esto recorre el objeto entero y censura por nombre de
 * key sin importar dónde aparezca. Complementa (no reemplaza) los paths
 * fijos de config/logger.ts, que cubren casos que esto no detectaría por
 * nombre (p. ej. "cookie").
 */
const SENSITIVE_KEY_PATTERN = /password|token|authorization|secret|creditcard|credit_card/i;
const CENSOR = "[redacted]";

export function sanitizeSensitiveFields<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value as object)) {
    // Referencia circular o ya procesada dentro de este mismo log — no
    // reprocesar evita loops infinitos con objetos que se referencian a sí
    // mismos (p. ej. err.cause apuntando de vuelta al mismo error).
    return value;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSensitiveFields(item, seen)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? CENSOR : sanitizeSensitiveFields(val, seen);
  }
  return result as T;
}
