/** e2e/fixtures/aislamiento.ts
 *
 * Generaliza la lógica de aislamiento-tenants.spec.ts (antes escrita a mano
 * solo para `repuestos`) en una función parametrizable por módulo — así
 * agregar Equipos/Checklists a la cobertura no significa copiar/pegar el
 * spec entero con los nombres de campo cambiados.
 *
 * El escenario que prueba es siempre el mismo, sea cual sea el módulo: el
 * tenant B crea una fila propia, el tenant A (autenticado por UI, sesión
 * real de navegador) intenta leerla/modificarla/borrarla sin tener acceso,
 * y se verifica tanto lo que A VE (debe ser 404, nunca 403 -- un 403
 * confirmaría que el recurso existe, filtrando ids de otro tenant) como lo
 * que pasó DE VERDAD en la base (releyendo desde la sesión de B: el fallo
 * catastrófico sería que la policy tape la lectura pero el UPDATE/DELETE sí
 * toque la fila).
 */
import { randomBytes } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { loginPorUI } from "./auth";

export interface ConfigAislamientoModulo {
  /** Segmento de ruta bajo /api/erp/ -- también se usa como parte de la
   *  marca aleatoria, para poder distinguir en los logs qué módulo falló. */
  modulo: string;
  /** Arma el body de creación de la fila "señuelo" de B. Recibe el
   *  APIRequestContext ya autenticado como B (por si el módulo necesita
   *  crear prerequisitos antes -- ej. checklists necesita un equipo y una
   *  plantilla propios) y la marca aleatoria de esta corrida, que el
   *  payload debe guardar en el campo declarado en `campoMarca`. */
  armarPayload: (requestB: APIRequestContext, marca: string) => Promise<Record<string, unknown>>;
  /** Campo de texto libre de la fila que va a contener la marca -- tiene
   *  que devolverse tal cual en el listado GET del módulo (no vale un
   *  campo que la API oculte o recorte). Sirve para encontrar la fila de B
   *  en el listado de A sin depender del id numérico (que NO es único
   *  entre tenants -- ver el comentario más abajo). */
  campoMarca: string;
  /** Body para el intento de modificación desde A. Si el módulo no tiene
   *  PUT (ej. checklists, que solo permite crear/listar/borrar), dejar
   *  undefined -- esa parte del escenario se saltea. */
  payloadModificacion?: Record<string, unknown>;
}

async function loginApi(
  request: APIRequestContext,
  slug: string,
  email: string,
  password: string
): Promise<void> {
  const res = await request.post("/api/auth/login", {
    data: { tenantSlug: slug, email, password },
  });
  expect(res.status(), `el login del tenant ${slug} debería funcionar`).toBe(200);
}

/** Ejecuta el escenario de aislamiento completo contra un módulo. `page` y
 *  `request` son los fixtures nativos de Playwright: `page` es el
 *  navegador real donde entra el tenant A (para que la sesión que ataca
 *  sea una cookie puesta por el navegador, no fabricada por el test);
 *  `request` es un jar de cookies aparte, usado para todo lo que hace el
 *  tenant B (que nunca se loguea en el navegador). */
export async function probarAislamientoDeModulo(
  { page, request }: { page: Page; request: APIRequestContext },
  tenantA: { email: string; password: string },
  tenantB: { slug: string; email: string; password: string },
  config: ConfigAislamientoModulo
): Promise<void> {
  const marca = `AISLA-${config.modulo}-${randomBytes(4).toString("hex").toUpperCase()}`;
  const ruta = `/api/erp/${config.modulo}`;

  // ── 1. El tenant B crea una fila propia ─────────────────────────────
  await loginApi(request, tenantB.slug, tenantB.email, tenantB.password);
  const payload = await config.armarPayload(request, marca);
  const creacion = await request.post(ruta, { data: payload });
  expect(creacion.status(), `crear en ${config.modulo} para B debería funcionar`).toBe(201);
  const filaB = await creacion.json();
  expect(
    filaB.id,
    `el backend debe devolver el id de la fila creada en ${config.modulo}`
  ).toBeTruthy();

  try {
    // ── 2. El tenant A entra por la UI real ───────────────────────────
    await loginPorUI(page, tenantA.email, tenantA.password);
    // A partir de acá se usa page.request, no request: comparte el jar de
    // cookies del navegador, así que cada llamada sale con la sesión real
    // del tenant A.

    // ── 3. El listado de A no incluye nada de B ───────────────────────
    // Por id NO alcanza -- es un serial por tenant, no global: el tenant A
    // puede tener perfectamente una fila propia con el mismo número.
    const listado = await page.request.get(`${ruta}?pageSize=200`);
    expect(listado.status()).toBe(200);
    const { data } = await listado.json();
    expect(
      data.find((fila: Record<string, unknown>) => fila[config.campoMarca] === marca),
      `la fila de B en ${config.modulo} no debe aparecer en el listado del tenant A`
    ).toBeUndefined();

    // ── 4. A no puede modificar ni borrar la fila de B ────────────────
    // 404 y NO 403: un 403 confirmaría que el recurso existe, lo que le
    // permitiría a un tenant mapear ids ajenos probando uno por uno.
    if (config.payloadModificacion) {
      const modificacion = await page.request.put(`${ruta}/${filaB.id}`, {
        data: config.payloadModificacion,
      });
      expect(
        modificacion.status(),
        `modificar una fila ajena en ${config.modulo} debe dar 404, no 403 ni 200`
      ).toBe(404);
    }

    const borrado = await page.request.delete(`${ruta}/${filaB.id}`);
    expect(
      borrado.status(),
      `borrar una fila ajena en ${config.modulo} debe dar 404, no 403 ni 200`
    ).toBe(404);

    // ── 5. La verificación que más importa ────────────────────────────
    // Los 404 de arriba prueban lo que el atacante VE, no lo que pasó en
    // la base. El fallo catastrófico sería que la policy tape la lectura
    // pero el UPDATE/DELETE sí toque la fila -- por eso se vuelve a
    // preguntar desde la sesión de B, la única que puede ver su propia fila.
    const verificacion = await request.get(`${ruta}?pageSize=200`);
    expect(verificacion.status()).toBe(200);
    const filaTrasIntento = (await verificacion.json()).data.find(
      (fila: Record<string, unknown>) => fila[config.campoMarca] === marca
    );
    expect(
      filaTrasIntento,
      `la fila de B en ${config.modulo} debe seguir existiendo, intacta`
    ).toBeTruthy();
  } finally {
    // Limpieza con la sesión de B (la única que alcanza la fila). En
    // `finally` para que un assert que falle no deje basura sembrada y
    // haga fallar la corrida siguiente en local, donde la base no es
    // efímera como en CI.
    await request.delete(`${ruta}/${filaB.id}`);
  }
}
