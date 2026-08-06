/** e2e/login.spec.ts
 *
 * Golden path de login: sin mocks, contra el sistema completo (Express +
 * build real de React + Postgres). El tenant y usuario de prueba los siembra
 * el workflow (o quien corra esto en local) con `npm run tenant:create`
 * antes de levantar el server — ver E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD.
 *
 * El campo "Empresa" no aparece: el build se genera con
 * VITE_DEFAULT_TENANT_SLUG ya apuntando al tenant sembrado (igual que
 * entraría un cliente real por su propio subdominio), así que el flujo
 * probado es el que usa la enorme mayoría de usuarios, no el de fallback
 * manual que hoy solo usa el dueño de la plataforma.
 */
import { test, expect } from "@playwright/test";

const email = process.env.E2E_ADMIN_EMAIL;
const password = process.env.E2E_ADMIN_PASSWORD;

if (!email || !password) {
  throw new Error(
    "Faltan E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD -- hay que sembrar el tenant/usuario de prueba antes de correr este spec (ver README o el job e2e-tests de ci.yml)"
  );
}

test("un usuario válido inicia sesión y llega al dashboard", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();

  // No hay ruteo por URL (SPA de una sola pantalla que cambia de tab por
  // estado) -- la señal real de que el login funcionó es que el shell
  // autenticado (sidebar con el tab "Dashboard") reemplazó al formulario.
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByLabel("Correo")).not.toBeVisible();
});
