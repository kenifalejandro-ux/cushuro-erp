/** src/server/shared/utils/pgError.ts */

/** true si error es un error de `pg` con el código de unique_violation
 *  (23505) — el catch(err: unknown) de Postgres no viene tipado, así que
 *  este chequeo reemplaza el `err.code === "23505"` repetido en cada
 *  service que inserta contra una columna UNIQUE. */
export function esViolacionUnicidad(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
