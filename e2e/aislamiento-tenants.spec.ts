/** e2e/aislamiento-tenants.spec.ts
 *
 * El test de seguridad más importante de un ERP multi-tenant: que un usuario
 * autenticado de un tenant no pueda ver ni tocar datos de otro. Corre contra
 * el sistema completo (Express + build real de React + Postgres con RLS), sin
 * mocks, porque justamente lo que se quiere probar es la cadena entera —
 * cookie de sesión → tenantMiddleware → withTenant() → policy de Postgres.
 * Cualquier eslabón mockeado invalidaría la prueba.
 *
 * Necesita DOS tenants sembrados (ver el job e2e-tests de ci.yml): el tenant
 * A es el del build (VITE_DEFAULT_TENANT_SLUG) y entra por la UI real; el
 * tenant B solo existe para tener datos ajenos que intentar alcanzar, así que
 * se maneja por API.
 *
 * Por qué el ataque es realista y no un escenario de laboratorio: el `id` de
 * repuestos es un `serial` (ver el registry de módulos), o sea un entero
 * secuencial y adivinable. Un usuario del tenant A no necesita filtrar nada
 * para conocer un id del tenant B: le basta probar 1, 2, 3. "No lo puede
 * adivinar" no es una defensa acá — la única defensa es que la fila esté
 * fuera de su alcance, que es exactamente lo que este spec verifica.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type APIRequestContext } from "@playwright/test";

function leerEnv(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) {
    throw new Error(
      `Falta ${nombre} -- este spec necesita DOS tenants sembrados con 'npm run tenant:create' antes de levantar el server (ver el job e2e-tests de ci.yml)`
    );
  }
  return valor;
}

// Tenant A: el del build. Entra por la UI porque es el único cuyo slug quedó
// horneado en el bundle — y de paso, la sesión que ataca es una cookie real
// puesta por el navegador, no una fabricada por el test.
const tenantA = {
  email: leerEnv("E2E_ADMIN_EMAIL"),
  password: leerEnv("E2E_ADMIN_PASSWORD"),
};

// Tenant B: la víctima. Nunca se loguea en el navegador.
const tenantB = {
  slug: leerEnv("E2E_TENANT_B_SLUG"),
  email: leerEnv("E2E_ADMIN_B_EMAIL"),
  password: leerEnv("E2E_ADMIN_B_PASSWORD"),
};

/** Login por API. El backend responde con la cookie httpOnly de sesión, que
 *  el APIRequestContext guarda en su propio jar — independiente del jar del
 *  navegador, así las dos sesiones conviven sin pisarse. */
async function loginApi(request: APIRequestContext, slug: string, email: string, password: string) {
  const res = await request.post("/api/auth/login", {
    data: { tenantSlug: slug, email, password },
  });
  expect(res.status(), `el login del tenant ${slug} debería funcionar`).toBe(200);
}

test("un usuario de un tenant no puede leer ni modificar datos de otro tenant", async ({
  page,
  request,
}) => {
  // ── 1. El tenant B crea un repuesto propio ────────────────────────────
  // El sufijo aleatorio evita chocar con el UNIQUE (tenant_id, codigo) entre
  // los tres navegadores del config, que corren este spec en paralelo.
  const codigoB = `AISLA-${randomBytes(4).toString("hex").toUpperCase()}`;
  const repuestoOriginal = {
    codigo: codigoB,
    nombre: "Filtro secreto del tenant B",
    categoria: "General",
    stock: 42,
    stock_minimo: 5,
    stock_maximo: 100,
    precio: 1234.56,
  };

  await loginApi(request, tenantB.slug, tenantB.email, tenantB.password);

  const creacion = await request.post("/api/erp/repuestos", { data: repuestoOriginal });
  expect(creacion.status()).toBe(201);
  const repuestoB = await creacion.json();
  expect(repuestoB.id, "el backend debe devolver el id del repuesto creado").toBeTruthy();

  try {
    // ── 2. El tenant A entra por la UI real ─────────────────────────────
    await page.goto("/");
    await page.getByLabel("Correo").fill(tenantA.email);
    await page.getByLabel("Contraseña").fill(tenantA.password);
    await page.getByRole("button", { name: "Ingresar" }).click();
    await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible();

    // A partir de acá se usa `page.request`, no `request`: comparte el jar de
    // cookies del navegador, así que cada llamada sale con la sesión real del
    // tenant A — es literalmente lo que podría hacer ese usuario desde la
    // consola del navegador con su sesión legítima abierta.

    // ── 3. El listado de A no incluye nada de B ─────────────────────────
    const listado = await page.request.get("/api/erp/repuestos?pageSize=200");
    expect(listado.status()).toBe(200);
    const { data } = await listado.json();
    expect(
      data.find((r: { codigo: string }) => r.codigo === codigoB),
      "el repuesto del tenant B no debe aparecer en el listado del tenant A"
    ).toBeUndefined();

    // ── 4. A no puede modificar ni borrar la fila de B ──────────────────
    // Se exige 404 y NO 403: un 403 ("prohibido") confirmaría que el recurso
    // existe, y eso ya es una fuga — le permitiría a un tenant mapear los ids
    // de otro probando uno por uno. Para el tenant A, una fila ajena tiene
    // que ser indistinguible de una que no existe.
    const modificacion = await page.request.put(`/api/erp/repuestos/${repuestoB.id}`, {
      data: { ...repuestoOriginal, nombre: "PWNED", stock: 0, precio: 0 },
    });
    expect(modificacion.status(), "modificar una fila ajena debe dar 404, no 403 ni 200").toBe(404);

    const borrado = await page.request.delete(`/api/erp/repuestos/${repuestoB.id}`);
    expect(borrado.status(), "borrar una fila ajena debe dar 404, no 403 ni 200").toBe(404);

    // ── 5. La verificación que más importa ──────────────────────────────
    // Los 404 de arriba prueban lo que el atacante VE, no lo que pasó en la
    // base. El fallo catastrófico sería que la policy tape la lectura pero el
    // UPDATE/DELETE sí toque la fila: el atacante vería un 404 tranquilizador
    // mientras corrompe datos ajenos en silencio. Por eso se vuelve a
    // preguntar desde la sesión de B, que es la única que puede ver su fila.
    const verificacion = await request.get("/api/erp/repuestos?pageSize=200");
    expect(verificacion.status()).toBe(200);
    const filaB = (await verificacion.json()).data.find(
      (r: { codigo: string }) => r.codigo === codigoB
    );

    expect(filaB, "el repuesto del tenant B debe seguir existiendo").toBeTruthy();
    expect(filaB.nombre, "el tenant A no debe haber alterado el nombre").toBe(
      repuestoOriginal.nombre
    );
    expect(Number(filaB.stock), "el tenant A no debe haber alterado el stock").toBe(
      repuestoOriginal.stock
    );
  } finally {
    // Limpieza con la sesión de B (la única que alcanza la fila). Va en
    // `finally` para que un assert que falle no deje basura sembrada y haga
    // fallar la corrida siguiente en local, donde la base no es efímera.
    await request.delete(`/api/erp/repuestos/${repuestoB.id}`);
  }
});
