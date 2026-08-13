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
import {
  abrirModalNuevoChecklist,
  botonRegistrar,
  checklistsDelEquipo,
  elegirEquipoYPlantilla,
  sembrarEquipoYPlantilla,
} from "./fixtures/checklists";
import { adminA } from "./fixtures/entorno";

test("doble clic en 'Registrar Checklist' crea UN solo checklist, no dos", async ({ page }) => {
  const marca = `DBL-${randomBytes(3).toString("hex").toUpperCase()}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);
  await sembrarEquipoYPlantilla(page, marca);

  await abrirModalNuevoChecklist(page);
  await elegirEquipoYPlantilla(page, marca);

  // dblclick() y no dos click() seguidos: dispara los dos eventos sin
  // revalidar que el botón siga habilitado entre medio, que es exactamente
  // lo que hace un dedo en una pantalla táctil. Dos click() por separado
  // rebotarían contra el `disabled` y el test pasaría sin haber ejercitado
  // el caso real.
  await botonRegistrar(page).dblclick();

  // El modal se cierra al guardar: es la señal de que el primer envío
  // terminó y ya se puede contar.
  await expect(botonRegistrar(page)).toBeHidden();

  const delEquipo = await checklistsDelEquipo(page, marca);
  expect(
    delEquipo,
    "el doble clic creó más de un checklist: el cliente_uuid no se mantuvo estable entre los dos envíos"
  ).toHaveLength(1);
});
