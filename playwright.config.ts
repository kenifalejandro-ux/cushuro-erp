/** playwright.config.ts
 *
 * E2E del sistema completo (Express + build de React + Postgres + Redis),
 * no un test de frontend aislado — por eso vive en la raíz, no en client/.
 *
 * `webServer` es quien decide cuándo el server está listo: arranca `npm
 * start` (el mismo comando que corre en producción) y hace polling a `url`
 * hasta recibir una respuesta 2xx, o falla el job entero si se agota
 * `timeout` sin que eso pase — así nunca se dispara un test contra un
 * server a medio arrancar, sin necesidad de un loop de curl escrito a mano
 * en el workflow.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.PORT || "3001";
const baseURL = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Reintentos solo en CI: un E2E real (navegador + red) tiene más ruido de
  // fondo que un unit test — un reintento absorbe ese ruido sin esconder un
  // fallo real (si vuelve a fallar en el reintento, sigue rompiendo el build).
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",

  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],

  webServer: {
    command: "npm start",
    url: `${baseURL}/health`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});
