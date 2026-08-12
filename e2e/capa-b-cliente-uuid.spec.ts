/** e2e/capa-b-cliente-uuid.spec.ts
 *
 * Prueba la "capa B" de la protección contra doble submit: que el
 * `cliente_uuid` esté atado al FORMULARIO ABIERTO y no al clic.
 *
 * ── Por qué hace falta este spec, si ya hay otros dos ───────────────────
 *
 * Ni `tests/idempotencia-offline.test.ts` ni
 * `e2e/doble-clic-duplicados.spec.ts` cubren esta propiedad:
 *
 *  - Los tests de servidor prueban "el MISMO cliente_uuid dos veces ⇒ una
 *    sola fila". Eso ya pasaba **con el bug puesto**: lo que estaba roto
 *    era que el cliente mandaba uuid DISTINTOS en cada clic, y el servidor
 *    no puede distinguir eso de dos inspecciones legítimas del mismo
 *    equipo (ni debe: es lo mismo que permite que dos operarios llenen un
 *    checklist del mismo camión en el mismo turno).
 *  - El `dblclick()` del otro spec prueba la experiencia real, pero si el
 *    navegador entrega el segundo clic contra el botón ya deshabilitado
 *    (capa A), pasa en verde sin haber ejercitado la capa B nunca. Verde
 *    ahí no es prueba de B.
 *
 * ── Cómo se prueba sin depender del timing de los clics ─────────────────
 *
 * Se intercepta el POST de creación y se responde **500**. Eso da tres
 * cosas de una: el modal queda abierto (ChecklistsView solo lo cierra si
 * `res.ok`), se puede submitear otra vez sobre la MISMA instancia del
 * formulario, y no se crean registros de prueba en la base. Cero
 * dependencia de que dos clics ganen una carrera contra un re-render.
 *
 * Se prueban las DOS mitades de la garantía, porque una sin la otra es
 * peligrosa:
 *   1. Dos submits del mismo modal ⇒ el MISMO uuid (si no, duplica).
 *   2. Cerrar y reabrir ⇒ uuid DISTINTO (si no, el segundo checklist
 *      legítimo del turno devolvería el primero en silencio — se perdería
 *      un registro, que es peor que el duplicado que se está evitando).
 *
 * Se hace sobre Checklists como representante: los 4 módulos usan el
 * mismo patrón. Extenderlo a IPERC/Combustible/Documentos es agregar la
 * parte de "llenar el formulario", que es distinta en cada uno.
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

const RUTA_CREACION = "/api/erp/checklists";

test("el cliente_uuid está atado al formulario abierto, no al clic", async ({ page }) => {
  const marca = `UUID-${randomBytes(3).toString("hex").toUpperCase()}`;

  await loginPorUI(page, admin.email, admin.password);

  // Prerrequisitos por API, ANTES de instalar la intercepción — así el
  // route no tiene que discriminar estas llamadas de las que sí importan.
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

  // El alert de error del 500 bloquearía el test si nadie lo atiende.
  page.on("dialog", (dialog) => void dialog.accept());

  const uuidsEnviados: string[] = [];
  await page.route(`**${RUTA_CREACION}`, async (route) => {
    const req = route.request();
    // Comparación exacta de pathname: sin esto, el glob también taparía
    // /api/erp/checklists/plantillas y este spec dejaría de poder crear
    // sus propios prerrequisitos si algún día se mueven acá abajo.
    const esCreacion = req.method() === "POST" && new URL(req.url()).pathname === RUTA_CREACION;
    if (!esCreacion) {
      await route.continue();
      return;
    }

    const body = req.postDataJSON() as { cliente_uuid?: string };
    if (body?.cliente_uuid) uuidsEnviados.push(body.cliente_uuid);

    // 500 y no continue(): mantiene el modal abierto para poder submitear
    // de nuevo sobre la misma instancia del formulario, y de paso no
    // ensucia la base con checklists de prueba.
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ message: "Error simulado por el test" }),
    });
  });

  await page.getByRole("button", { name: "Checklists" }).first().click();
  await page.getByRole("button", { name: "+ Nuevo Checklist" }).click();
  await page.getByLabel("Equipo").selectOption({ label: marca });
  await page.getByLabel("Plantilla").selectOption({ label: `Pre-uso ${marca}` });
  // El submit está deshabilitado hasta que la plantilla cargó sus ítems.
  await expect(page.getByText("Frenos")).toBeVisible();

  const botonRegistrar = page.getByRole("button", { name: /Registrar Checklist|Registrando/ });

  // ── Mitad 1: dos submits del MISMO modal ─────────────────────────────
  // Secuenciales y esperando cada uno, a propósito: lo que se prueba acá
  // NO es que dos clics simultáneos se bloqueen (eso es la capa A, y ya
  // lo cubre doble-clic-duplicados.spec.ts) sino que el uuid no cambie
  // entre un envío y el siguiente del mismo formulario.
  await botonRegistrar.click();
  await expect.poll(() => uuidsEnviados.length).toBe(1);

  await botonRegistrar.click();
  await expect.poll(() => uuidsEnviados.length).toBe(2);

  const unicos = new Set(uuidsEnviados);
  expect(
    unicos.size,
    `Dos envíos del MISMO modal mandaron ${unicos.size} cliente_uuid distintos (se esperaba 1). ` +
      `El uuid volvió a generarse dentro del handler de submit en vez de al abrir el formulario, ` +
      `así que un doble clic crearía dos checklists. UUIDs: ${[...unicos].join(", ")}`
  ).toBe(1);

  const uuidDelPrimerModal = [...unicos][0];

  // ── Mitad 2: cerrar y reabrir ⇒ uuid NUEVO ───────────────────────────
  await page.getByRole("button", { name: "×" }).click();
  await expect(botonRegistrar).toBeHidden();

  uuidsEnviados.length = 0;
  await page.getByRole("button", { name: "+ Nuevo Checklist" }).click();

  // Cerrar el modal deja `plantillaSeleccionada` en null pero NO limpia el
  // <select>, así que volver a elegir la misma opción no dispararía
  // onChange (el value no cambia) y el submit quedaría deshabilitado para
  // siempre. Pasar por la opción vacía fuerza los dos cambios.
  await page.getByLabel("Plantilla").selectOption({ value: "" });
  await page.getByLabel("Plantilla").selectOption({ label: `Pre-uso ${marca}` });
  await expect(page.getByText("Frenos")).toBeVisible();

  await botonRegistrar.click();
  await expect.poll(() => uuidsEnviados.length).toBe(1);

  expect(
    uuidsEnviados[0],
    `Al reabrir el modal se reusó el cliente_uuid de la vez anterior. Eso NO duplica, hace algo ` +
      `peor: el segundo checklist legítimo del turno chocaría contra la clave del primero y el ` +
      `servidor devolvería aquel en silencio — se perdería un registro sin que nadie se entere.`
  ).not.toBe(uuidDelPrimerModal);
});
