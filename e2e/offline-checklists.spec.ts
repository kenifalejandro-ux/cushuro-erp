/** e2e/offline-checklists.spec.ts
 *
 * El flujo de campo completo, sin mocks: un operario llena un checklist con
 * el navegador SIN RED, el trabajo no se pierde, y cuando vuelve la señal se
 * sincroniza solo — una sola vez, sin duplicar.
 *
 * Es el único test que puede probar esto de verdad. Los unit tests de
 * tests/idempotencia-offline.test.ts cubren el lado del servidor (mismo
 * cliente_uuid ⇒ una sola fila), y tests/offline-registry.test.ts cubre qué
 * rutas se declaran encolables — pero ninguno de los dos puede ejercitar la
 * cadena real: fetch fallando por red → apiFetch encolando en IndexedDB →
 * el evento "online" del navegador → drenaje → la fila apareciendo en el
 * listado. Eso necesita un navegador de verdad con la red cortada, que es
 * justo lo que da context.setOffline().
 *
 * Necesita el tenant A sembrado igual que los otros specs (ver el job
 * e2e-tests de ci.yml).
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";

function leerEnv(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) {
    throw new Error(
      `Falta ${nombre} -- este spec necesita el tenant A sembrado con 'npm run tenant:create' antes de levantar el server (ver el job e2e-tests de ci.yml)`
    );
  }
  return valor;
}

const admin = {
  email: leerEnv("E2E_ADMIN_EMAIL"),
  password: leerEnv("E2E_ADMIN_PASSWORD"),
};

test("un checklist llenado sin red se guarda en el equipo y se sincroniza solo al volver la señal", async ({
  page,
  context,
}) => {
  const marca = `OFF-${randomBytes(3).toString("hex").toUpperCase()}`;

  await loginPorUI(page, admin.email, admin.password);

  // Prerrequisitos por API (el foco del test es el offline, no volver a
  // probar los formularios de equipo/plantilla). page.request comparte el
  // jar de cookies del navegador, así que va autenticado con la MISMA
  // sesión que acaba de entrar por la UI.
  const equipo = await page.request.post("/api/erp/equipos", {
    data: { placa_codigo: marca, tipo: "Camioneta" },
  });
  expect(equipo.status()).toBe(201);

  const plantilla = await page.request.post("/api/erp/checklists/plantillas", {
    data: {
      nombre: `Pre-uso ${marca}`,
      items: [{ descripcion: "Frenos" }, { descripcion: "Luces" }],
    },
  });
  expect(plantilla.status()).toBe(201);

  // El alert() de "quedó guardado en este equipo" bloquearía el test si
  // nadie lo atiende — Playwright descarta los diálogos por default, pero
  // acá además se verifica el texto: es la única confirmación que el
  // operario recibe de que su trabajo NO se perdió.
  const mensajes: string[] = [];
  page.on("dialog", (dialog) => {
    mensajes.push(dialog.message());
    void dialog.accept();
  });

  await page.getByRole("button", { name: "Checklists" }).first().click();
  await page.getByRole("button", { name: "+ Nuevo Checklist" }).click();

  // Equipo y plantilla se eligen TODAVÍA CON RED: seleccionar la plantilla
  // dispara el GET de sus ítems, y sin ellos no hay formulario que llenar.
  // Es también el caso real — el operario abre la app en la base, donde hay
  // señal, y la pierde camino a la cancha.
  await page.getByLabel("Equipo").selectOption({ label: marca });
  await page.getByLabel("Plantilla").selectOption({ label: `Pre-uso ${marca}` });
  await expect(page.getByText("Frenos")).toBeVisible();

  // ── Se corta la red ──────────────────────────────────────────────────
  await context.setOffline(true);

  await page.getByRole("button", { name: "Registrar Checklist" }).click();

  await expect
    .poll(() => mensajes.join(" "), {
      message: "el operario tiene que ver que su checklist quedó guardado, no un error",
    })
    .toContain("Sin conexión");

  // La franja del Layout, visible desde cualquier pantalla.
  await expect(page.getByRole("status")).toContainText("Sin conexión");

  // ── Vuelve la red ────────────────────────────────────────────────────
  await context.setOffline(false);

  // El drenaje lo dispara el evento "online" del navegador o, si ese evento
  // no llega (cada navegador lo implementa distinto, y en campo puede no
  // dispararse nunca con señal intermitente), el reintento periódico de
  // offlineSync.ts — de ahí el timeout holgado, que cubre más de un ciclo.
  //
  // Se espera a que el checklist aparezca en el LISTADO: es la prueba de que
  // la cola se vació contra el servidor de verdad, no solo de que el badge
  // cambió de estado.
  await expect(page.getByRole("cell", { name: marca })).toBeVisible({ timeout: 45_000 });

  // Y lo que más importa: UNA sola fila. Si la cola hubiera reintentado sin
  // idempotencia (o si el 202 se hubiera contado como creación), acá
  // habría dos checklists para un solo trabajo real.
  const listado = await page.request.get("/api/erp/checklists?pageSize=100");
  const cuerpo = await listado.json();
  const delEquipo = (cuerpo.data as { placa_codigo: string }[]).filter(
    (c) => c.placa_codigo === marca
  );
  expect(delEquipo).toHaveLength(1);

  // La franja desaparece cuando no queda nada pendiente.
  await expect(page.getByRole("status")).toBeHidden();
});
