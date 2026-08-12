/** e2e/doble-clic-duplicados.spec.ts
 *
 * Un doble clic (o doble tap en una tablet lenta, con guantes, en campo) no
 * debe crear dos registros.
 *
 * Por qué esto necesita un navegador de verdad y no alcanza con los tests
 * de servidor: `tests/idempotencia-offline.test.ts` ya prueba que dos POST
 * con el MISMO cliente_uuid crean una sola fila. Lo que no puede probar es
 * que el cliente mande efectivamente el mismo uuid las dos veces — que es
 * justo donde estaba el hueco. Mientras el uuid se generaba dentro del
 * handler de submit, cada clic mandaba una clave nueva y el servidor los
 * veía como dos registros legítimamente distintos (no puede distinguir un
 * dedo torpe de dos operarios inspeccionando el mismo camión). Solo un
 * `dblclick()` real sobre el botón real ejercita esa cadena entera.
 *
 * Se prueba con Checklists como representante: los cuatro módulos con
 * escrituras idempotentes (Checklists, IPERC, Combustible, Documentos) usan
 * exactamente el mismo patrón -- uuid fijado al abrir el modal + botón
 * bloqueado mientras vuela la request.
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

test("doble clic en 'Registrar Checklist' crea UN solo checklist, no dos", async ({ page }) => {
  const marca = `DBL-${randomBytes(3).toString("hex").toUpperCase()}`;

  await loginPorUI(page, admin.email, admin.password);

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

  await page.getByRole("button", { name: "Checklists" }).first().click();
  await page.getByRole("button", { name: "+ Nuevo Checklist" }).click();
  await page.getByLabel("Equipo").selectOption({ label: marca });
  await page.getByLabel("Plantilla").selectOption({ label: `Pre-uso ${marca}` });
  await expect(page.getByText("Frenos")).toBeVisible();

  // dblclick() y no dos click() seguidos: dispara los dos eventos sin
  // revalidar que el botón siga habilitado entre medio, que es exactamente
  // lo que hace un dedo en una pantalla táctil. Dos click() por separado
  // rebotarían contra el `disabled` y el test pasaría sin haber ejercitado
  // el caso real.
  await page.getByRole("button", { name: /Registrar Checklist|Registrando/ }).dblclick();

  // El modal se cierra al guardar: es la señal de que el primer envío
  // terminó y ya se puede contar.
  await expect(page.getByRole("button", { name: /Registrar Checklist|Registrando/ })).toBeHidden();

  const listado = await page.request.get("/api/erp/checklists?pageSize=100");
  const cuerpo = await listado.json();
  const delEquipo = (cuerpo.data as { placa_codigo: string }[]).filter(
    (c) => c.placa_codigo === marca
  );
  expect(
    delEquipo,
    "el doble clic creó más de un checklist: el cliente_uuid no se mantuvo estable entre los dos envíos"
  ).toHaveLength(1);
});
