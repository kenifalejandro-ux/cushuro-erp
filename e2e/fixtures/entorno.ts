/** e2e/fixtures/entorno.ts
 *
 * Las credenciales de los tenants sembrados para e2e, leídas del entorno.
 *
 * Vivían copiadas en CUATRO specs (la misma función `leerEnv` más el mismo
 * objeto de credenciales), lo que hacía que renombrar una variable de
 * entorno en ci.yml exigiera acordarse de los cuatro archivos.
 *
 * Son funciones y no constantes de módulo a propósito: si fueran
 * constantes, importar este archivo desde un spec que solo necesita el
 * tenant A lo haría fallar igual cuando falta el B — y correr solo los
 * specs de checklists sin el segundo tenant sembrado es un caso normal
 * (`npm run e2e:local -- e2e/capa-b-cliente-uuid.spec.ts`).
 */

export function leerEnv(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) {
    throw new Error(
      `Falta ${nombre} -- los specs e2e necesitan los tenants sembrados. Corré 'npm run e2e:local' (lo hace solo) o mirá el job e2e-tests de ci.yml.`
    );
  }
  return valor;
}

/** El tenant del build: su slug queda horneado en el bundle
 *  (VITE_DEFAULT_TENANT_SLUG), así que es el único que puede entrar por la
 *  UI sin escribir la empresa a mano. */
export function adminA() {
  return {
    email: leerEnv("E2E_ADMIN_EMAIL"),
    password: leerEnv("E2E_ADMIN_PASSWORD"),
  };
}

/** El segundo tenant existe solo para que el spec de aislamiento tenga
 *  datos ajenos que intentar alcanzar. Nunca entra por el navegador, así
 *  que además del email hace falta su slug para el login por API. */
export function adminB() {
  return {
    slug: leerEnv("E2E_TENANT_B_SLUG"),
    email: leerEnv("E2E_ADMIN_B_EMAIL"),
    password: leerEnv("E2E_ADMIN_B_PASSWORD"),
  };
}
