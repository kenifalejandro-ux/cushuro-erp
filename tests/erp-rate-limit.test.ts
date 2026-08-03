/** tests/erp-rate-limit.test.ts
 *
 * Rate limit de /api/erp/* (middleware/erpRateLimiter.ts). Hasta que existió,
 * las rutas de negocio no tenían NINGUNO: las cuotas frenan el volumen
 * acumulado, no la frecuencia — nada impedía miles de GET por segundo.
 *
 * Lo importante a blindar es que el presupuesto sea POR TENANT: con una
 * clave solo por IP, un cliente abusivo consumiría el cupo de los demás, que
 * es exactamente el fallo que un sistema multi-tenant no puede tener.
 *
 * El límite se ajusta mutando `env` en vez de mandar cientos de requests: el
 * middleware lo lee en cada request, así que un test puede fijarlo en 3 y
 * verificar el comportamiento real sin volverse lento.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { env } from "../src/server/config/env";
import { closeDatabase } from "../src/server/config/database";

const password = "ClaveDePrueba123";
const tenantsCreados: string[] = [];
const limiteOriginal = env.erpRateLimitMaxRequests;

async function nuevoAgente() {
  const { tenant, usuario } = await crearTenantDePrueba(password);
  tenantsCreados.push(tenant.id);
  const agente = request.agent(app);
  await agente.post("/api/auth/login").send({ tenantSlug: tenant.slug, email: usuario.email, password });
  return { agente, tenant };
}

beforeEach(() => {
  // Ventana larga para que nada expire a mitad de un test.
  env.erpRateLimitWindowMs = 60_000;
});

afterEach(() => {
  env.erpRateLimitMaxRequests = limiteOriginal;
});

afterAll(async () => {
  env.erpRateLimitMaxRequests = limiteOriginal;
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("rate limit de /api/erp/*", () => {
  it("deja pasar hasta el límite y responde 429 al excederlo", async () => {
    const { agente } = await nuevoAgente();
    env.erpRateLimitMaxRequests = 3;

    for (let i = 0; i < 3; i++) {
      expect((await agente.get("/api/erp/equipos")).status).toBe(200);
    }

    const bloqueado = await agente.get("/api/erp/equipos");
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.error).toBe("rate_limit_excedido");
    expect(bloqueado.headers["retry-after"]).toBeDefined();
    expect(Number(bloqueado.body.retryAfterSeconds)).toBeGreaterThan(0);
  });

  it("el presupuesto es POR TENANT: un tenant saturado no afecta a otro", async () => {
    const a = await nuevoAgente();
    const b = await nuevoAgente();
    env.erpRateLimitMaxRequests = 2;

    // A quema su cupo entero.
    await a.agente.get("/api/erp/equipos");
    await a.agente.get("/api/erp/equipos");
    expect((await a.agente.get("/api/erp/equipos")).status).toBe(429);

    // B, desde la misma IP, sigue entrando: la clave incluye el tenant.
    expect((await b.agente.get("/api/erp/equipos")).status).toBe(200);
  });

  it("el presupuesto es compartido entre TODAS las rutas del ERP, no por ruta", async () => {
    const { agente } = await nuevoAgente();
    env.erpRateLimitMaxRequests = 3;

    // Tres rutas distintas consumen el mismo contador — a diferencia del
    // rateLimiter genérico, que cuenta por ruta.
    expect((await agente.get("/api/erp/equipos")).status).toBe(200);
    expect((await agente.get("/api/erp/repuestos")).status).toBe(200);
    expect((await agente.get("/api/erp/documentos")).status).toBe(200);

    expect((await agente.get("/api/erp/combustible")).status).toBe(429);
  });

  it("alcanza también a los POST, no solo a las lecturas", async () => {
    const { agente } = await nuevoAgente();
    env.erpRateLimitMaxRequests = 1;

    expect((await agente.get("/api/erp/equipos")).status).toBe(200);

    const creacion = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EQ"), tipo: "Camioneta" });
    expect(creacion.status).toBe(429);
  });

  it("en 0 queda desactivado (escotilla de emergencia)", async () => {
    const { agente } = await nuevoAgente();
    env.erpRateLimitMaxRequests = 0;

    for (let i = 0; i < 5; i++) {
      expect((await agente.get("/api/erp/equipos")).status).toBe(200);
    }
  });

  it("no toca las rutas de plataforma ni de auth (tienen sus propios límites)", async () => {
    const { agente } = await nuevoAgente();
    env.erpRateLimitMaxRequests = 1;

    await agente.get("/api/erp/equipos"); // consume el único cupo del ERP
    expect((await agente.get("/api/erp/equipos")).status).toBe(429);

    // El panel sigue respondiendo: su rate limit es otro y su presupuesto
    // también.
    const plataforma = await request(app)
      .get("/api/platform/planes")
      .set("Authorization", `Bearer ${env.platformAdminToken}`);
    expect(plataforma.status).toBe(200);
  });

  it("distingue 429 (frecuencia) de 403 cuota_excedida (volumen)", async () => {
    const { agente } = await nuevoAgente();
    env.erpRateLimitMaxRequests = 1;
    await agente.get("/api/erp/equipos");

    const res = await agente.get("/api/erp/equipos");
    // Son problemas distintos y se resuelven distinto (esperar vs. pedir más
    // cupo), así que el cliente tiene que poder distinguirlos sin parsear
    // texto.
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limit_excedido");
    expect(res.body.error).not.toBe("cuota_excedida");
  });
});
