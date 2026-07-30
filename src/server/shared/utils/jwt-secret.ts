/** src/server/shared/utils/jwt-secret.ts
 *
 * Único punto de lectura de JWT_SECRET. Antes estaba duplicado (misma
 * función) en auth.service.ts y auth.middleware.ts — cualquier cambio a la
 * validación (o al mensaje de error) requería tocar los dos archivos y
 * mantenerlos sincronizados a mano.
 */
export function requerirJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET no está configurado. Defínelo en el archivo .env antes de iniciar el servidor.");
  }
  return secret;
}
