import { describe, it, expect, vi, afterAll } from "vitest";
import request from "supertest";

// appApexDomain va vacío en el .env real de desarrollo (todavía no hay
// dominio de producción) — se fija acá solo para este archivo de test, así
// se puede probar de verdad la resolución por subdominio sin depender de
// infraestructura real. vitest aísla el registro de módulos por archivo,
// así que este mock no afecta a los demás tests.
vi.mock("../src/server/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/config/env")>();
  return { ...actual, env: { ...actual.env, appApexDomain: "mincoreerp.test" } };
});

// Sin esto, resolveTxt de verdad saldría a internet a buscar un TXT record
// que no existe para un dominio de prueba (*.test.local) — se mockea para
// poder probar tanto "todavía sin verificar" (rechaza con ENOTFOUND, el
// default acá) como "verificado" (mockResolvedValueOnce puntual en el test
// que lo necesita) sin depender de DNS real.
vi.mock("dns/promises", () => ({
  resolveTxt: vi.fn().mockRejectedValue(Object.assign(new Error("no encontrado"), { code: "ENOTFOUND" })),
}));

// Importar DESPUÉS del mock: helpers → createApp() → resolveTenantSubdomain
// arrastran `env` transitivamente, y necesitan ver ya la versión mockeada.
const { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } = await import("./helpers");
const { env } = await import("../src/server/config/env");
const { closeDatabase } = await import("../src/server/config/database");

describe("resolución de tenant por Host (dominio propio / subdominio)", () => {
  const password = "ClaveDePrueba123";
  const tenantsCreados: string[] = [];

  afterAll(async () => {
    for (const id of tenantsCreados) await borrarTenantDePrueba(id);
    await closeDatabase();
  });

  it("un dominio propio recién asignado (sin verificar) NO resuelve login — solo después de confirmar el TXT record", async () => {
    const creado = await crearTenantDePrueba(password);
    tenantsCreados.push(creado.tenant.id);

    const dominioPropio = `${idUnico("dominio")}.test.local`;
    const asignar = await request(app)
      .patch(`/api/platform/tenants/${creado.tenant.id}/dominio`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({ dominioPersonalizado: dominioPropio });
    expect(asignar.status).toBe(200);
    expect(asignar.body.dominio.dominioEstado).toBe("pendiente_verificacion");

    // Todavía sin verificar (el mock de dns/promises rechaza por default) —
    // el Host no debe alcanzar para resolver el tenant.
    const antesDeVerificar = await request(app)
      .post("/api/auth/login")
      .set("Host", dominioPropio)
      .send({ tenantSlug: "esto-no-deberia-usarse-jamas", email: creado.usuario.email, password });
    expect(antesDeVerificar.status).not.toBe(200);

    const { resolveTxt } = await import("dns/promises");
    vi.mocked(resolveTxt).mockResolvedValueOnce([[asignar.body.dominio.dominioValorEsperado]]);

    const verificar = await request(app)
      .post(`/api/platform/tenants/${creado.tenant.id}/dominio/verificar`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`);
    expect(verificar.status).toBe(200);
    expect(verificar.body.dominio.dominioEstado).toBe("activo");

    const login = await request(app)
      .post("/api/auth/login")
      .set("Host", dominioPropio)
      .send({ tenantSlug: "esto-no-deberia-usarse-jamas", email: creado.usuario.email, password });

    expect(login.status).toBe(200);
    expect(login.body.usuario.tenantId).toBe(creado.tenant.id);
  });

  it("resuelve por subdominio de la plataforma (<slug>.mincoreerp.test) cuando no hay dominio propio", async () => {
    const creado = await crearTenantDePrueba(password);
    tenantsCreados.push(creado.tenant.id);

    const login = await request(app)
      .post("/api/auth/login")
      .set("Host", `${creado.tenant.slug}.mincoreerp.test`)
      .send({ tenantSlug: "tampoco-deberia-usarse", email: creado.usuario.email, password });

    expect(login.status).toBe(200);
    expect(login.body.usuario.tenantId).toBe(creado.tenant.id);
  });

  it("un subdominio reservado (www) NO se interpreta como tenant — cae al campo manual del body", async () => {
    const creado = await crearTenantDePrueba(password);
    tenantsCreados.push(creado.tenant.id);

    const login = await request(app)
      .post("/api/auth/login")
      .set("Host", "www.mincoreerp.test")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    expect(login.status).toBe(200);
    expect(login.body.usuario.tenantId).toBe(creado.tenant.id);
  });

  it("un Host que no coincide con ningún dominio propio ni patrón de subdominio respeta el tenantSlug del body", async () => {
    const creado = await crearTenantDePrueba(password);
    tenantsCreados.push(creado.tenant.id);

    const login = await request(app)
      .post("/api/auth/login")
      .set("Host", "algun-dominio-sin-relacion.com")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    expect(login.status).toBe(200);
    expect(login.body.usuario.tenantId).toBe(creado.tenant.id);
  });
});
