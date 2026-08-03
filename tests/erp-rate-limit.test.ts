/** tests/erp-rate-limit.test.ts
 *
 * Rate limit de /api/erp/* en dos niveles (middleware/erpRateLimiter.ts).
 * Ver docs/architecture/cuotas-por-tenant.md.
 *
 * Lo importante a blindar son las dos propiedades que hacen que este diseño
 * sirva y que no son obvias:
 *
 *   1. Se cuenta por USUARIO, no por IP. En este despliegue la IP no
 *      identifica a nadie: los de oficina comparten el NAT de la empresa y
 *      los de planta usan datos móviles (CGNAT + IP cambiante). Dos usuarios
 *      del mismo tenant, desde la misma IP, deben tener presupuestos
 *      separados.
 *
 *   2. Un usuario que choca contra su fusible NO consume el presupuesto del
 *      tenant. Si lo hiciera, un script descontrolado bloquearía a los
 *      compañeros — el daño que el nivel por usuario existe para contener.
 *
 * Los límites se ajustan mutando `env` (el middleware los lee en cada
 * request) en vez de mandar cientos de requests: mismo patrón que los tests
 * de backups con el driver de storage.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { env } from "../src/server/config/env";
import { closeDatabase } from "../src/server/config/database";

const password = "ClaveDePrueba123";
const BEARER = `Bearer ${env.platformAdminToken}`;
const tenantsCreados: string[] = [];
const usuarioMaxOriginal = env.erpRateLimitUsuarioMax;
const tenantMaxOriginal = env.erpRateLimitTenantMax;

async function nuevoTenantConAgente() {
  const { tenant, usuario } = await crearTenantDePrueba(password);
  tenantsCreados.push(tenant.id);
  const agente = request.agent(app);
  await agente.post("/api/auth/login").send({ tenantSlug: tenant.slug, email: usuario.email, password });
  return { agente, tenant, usuario };
}

/** Segundo usuario DEL MISMO tenant, logueado aparte — para probar que el
 *  presupuesto es por persona y no por empresa ni por IP (supertest siempre
 *  sale por 127.0.0.1, así que la IP es idéntica para los dos). */
async function segundoUsuarioDe(tenant: { id: string; slug: string }) {
  const email = `${idUnico("u2")}@test.dev`;
  const creado = await request(app)
    .post(`/api/platform/tenants/${tenant.id}/usuarios`)
    .set("Authorization", BEARER)
    .send({ nombre: "Segundo", email, password });
  expect(creado.status).toBe(201);

  const agente = request.agent(app);
  await agente.post("/api/auth/login").send({ tenantSlug: tenant.slug, email, password });
  return agente;
}

beforeEach(() => {
  env.erpRateLimitWindowMs = 60_000; // ventana larga: nada expira a mitad de un test
  env.erpRateLimitUsuarioMax = 100000;
  env.erpRateLimitTenantMax = 100000;
});

afterEach(() => {
  env.erpRateLimitUsuarioMax = usuarioMaxOriginal;
  env.erpRateLimitTenantMax = tenantMaxOriginal;
});

afterAll(async () => {
  env.erpRateLimitUsuarioMax = usuarioMaxOriginal;
  env.erpRateLimitTenantMax = tenantMaxOriginal;
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("nivel 1: fusible por usuario", () => {
  it("deja pasar hasta el límite y devuelve 429 con nivel 'usuario'", async () => {
    const { agente } = await nuevoTenantConAgente();
    env.erpRateLimitUsuarioMax = 3;

    for (let i = 0; i < 3; i++) {
      expect((await agente.get("/api/erp/equipos")).status).toBe(200);
    }

    const bloqueado = await agente.get("/api/erp/equipos");
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.error).toBe("rate_limit_usuario");
    expect(bloqueado.body.nivel).toBe("usuario");
    expect(bloqueado.headers["retry-after"]).toBeDefined();
  });

  it("DOS usuarios del mismo tenant y la misma IP tienen presupuestos separados", async () => {
    // El caso que motivó todo el diseño: si se contara por IP, el segundo
    // usuario heredaría el bloqueo del primero solo por estar en la misma red.
    const { agente: primero, tenant } = await nuevoTenantConAgente();
    const segundo = await segundoUsuarioDe(tenant);
    env.erpRateLimitUsuarioMax = 2;

    await primero.get("/api/erp/equipos");
    await primero.get("/api/erp/equipos");
    expect((await primero.get("/api/erp/equipos")).status).toBe(429);

    // El segundo, misma empresa y misma IP, entra sin problema.
    expect((await segundo.get("/api/erp/equipos")).status).toBe(200);
  });

  it("el presupuesto se comparte entre TODAS las rutas del ERP, no por ruta", async () => {
    const { agente } = await nuevoTenantConAgente();
    env.erpRateLimitUsuarioMax = 3;

    expect((await agente.get("/api/erp/equipos")).status).toBe(200);
    expect((await agente.get("/api/erp/repuestos")).status).toBe(200);
    expect((await agente.get("/api/erp/documentos")).status).toBe(200);

    // A diferencia del rateLimiter genérico, que cuenta por ruta.
    expect((await agente.get("/api/erp/combustible")).status).toBe(429);
  });

  it("alcanza también a los POST, no solo a las lecturas", async () => {
    const { agente } = await nuevoTenantConAgente();
    env.erpRateLimitUsuarioMax = 1;

    expect((await agente.get("/api/erp/equipos")).status).toBe(200);
    const creacion = await agente.post("/api/erp/equipos").send({ placa_codigo: idUnico("EQ"), tipo: "Camioneta" });
    expect(creacion.status).toBe(429);
  });
});

describe("nivel 2: techo del tenant", () => {
  it("devuelve 429 con nivel 'tenant' y un mensaje distinto al personal", async () => {
    const { agente } = await nuevoTenantConAgente();
    env.erpRateLimitTenantMax = 2;

    await agente.get("/api/erp/equipos");
    await agente.get("/api/erp/equipos");

    const bloqueado = await agente.get("/api/erp/equipos");
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.error).toBe("rate_limit_tenant");
    expect(bloqueado.body.nivel).toBe("tenant");
    // Los mensajes tienen que ser distintos: uno se arregla esperando, el
    // otro es señal de que la empresa necesita atención.
    expect(bloqueado.body.message).toMatch(/empresa/i);
  });

  it("alcanza a TODOS los usuarios del tenant, aunque cada uno tenga cupo personal", async () => {
    const { agente: primero, tenant } = await nuevoTenantConAgente();
    const segundo = await segundoUsuarioDe(tenant);
    env.erpRateLimitUsuarioMax = 100; // el fusible personal no se toca
    env.erpRateLimitTenantMax = 2;

    await primero.get("/api/erp/equipos");
    await primero.get("/api/erp/equipos");

    // El segundo usuario tiene cupo personal de sobra, pero la empresa ya
    // agotó el suyo.
    const bloqueado = await segundo.get("/api/erp/equipos");
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.nivel).toBe("tenant");
  });

  it("el techo de un tenant no afecta a otro", async () => {
    const a = await nuevoTenantConAgente();
    const b = await nuevoTenantConAgente();
    env.erpRateLimitTenantMax = 2;

    await a.agente.get("/api/erp/equipos");
    await a.agente.get("/api/erp/equipos");
    expect((await a.agente.get("/api/erp/equipos")).status).toBe(429);

    expect((await b.agente.get("/api/erp/equipos")).status).toBe(200);
  });
});

describe("interacción entre los dos niveles", () => {
  it("un usuario bloqueado por su fusible NO consume el presupuesto del tenant", async () => {
    // La propiedad menos obvia y la más importante: si los requests
    // rechazados del nivel 1 contaran para el nivel 2, un solo script
    // descontrolado se comería el presupuesto de toda la empresa y
    // terminaría bloqueando a sus compañeros — justo el daño que el fusible
    // personal existe para contener.
    const { agente: descontrolado, tenant } = await nuevoTenantConAgente();
    const companiero = await segundoUsuarioDe(tenant);

    env.erpRateLimitUsuarioMax = 2;
    env.erpRateLimitTenantMax = 6;

    // El primero consume sus 2 y después se estrella 10 veces contra su
    // fusible. Si esos 10 contaran, el tenant quedaría muy por encima de 6.
    await descontrolado.get("/api/erp/equipos");
    await descontrolado.get("/api/erp/equipos");
    for (let i = 0; i < 10; i++) {
      const res = await descontrolado.get("/api/erp/equipos");
      expect(res.body.nivel).toBe("usuario");
    }

    // El compañero sigue trabajando: el tenant solo consumió 2 de sus 6.
    expect((await companiero.get("/api/erp/equipos")).status).toBe(200);
    expect((await companiero.get("/api/erp/equipos")).status).toBe(200);
  });

  it("el fusible personal se evalúa ANTES que el techo del tenant", async () => {
    const { agente } = await nuevoTenantConAgente();
    // Los dos en 1: el que debe reportarse es el personal, que es el más
    // específico y accionable para quien recibe el error.
    env.erpRateLimitUsuarioMax = 1;
    env.erpRateLimitTenantMax = 1;

    await agente.get("/api/erp/equipos");
    const bloqueado = await agente.get("/api/erp/equipos");
    expect(bloqueado.body.nivel).toBe("usuario");
  });
});

describe("configuración", () => {
  it("cada nivel se desactiva por separado con 0", async () => {
    const { agente } = await nuevoTenantConAgente();

    // Sin fusible personal, pero con techo de empresa.
    env.erpRateLimitUsuarioMax = 0;
    env.erpRateLimitTenantMax = 2;
    await agente.get("/api/erp/equipos");
    await agente.get("/api/erp/equipos");
    expect((await agente.get("/api/erp/equipos")).body.nivel).toBe("tenant");
  });

  it("los dos en 0 desactivan el rate limit por completo (escotilla de emergencia)", async () => {
    const { agente } = await nuevoTenantConAgente();
    env.erpRateLimitUsuarioMax = 0;
    env.erpRateLimitTenantMax = 0;

    for (let i = 0; i < 5; i++) {
      expect((await agente.get("/api/erp/equipos")).status).toBe(200);
    }
  });

  it("no toca las rutas de plataforma ni de auth (tienen sus propios límites)", async () => {
    const { agente } = await nuevoTenantConAgente();
    env.erpRateLimitUsuarioMax = 1;

    await agente.get("/api/erp/equipos");
    expect((await agente.get("/api/erp/equipos")).status).toBe(429);

    const plataforma = await request(app).get("/api/platform/planes").set("Authorization", BEARER);
    expect(plataforma.status).toBe(200);
  });

  it("se distingue del 403 de cuota: son problemas distintos con soluciones distintas", async () => {
    const { agente } = await nuevoTenantConAgente();
    env.erpRateLimitUsuarioMax = 1;
    await agente.get("/api/erp/equipos");

    const res = await agente.get("/api/erp/equipos");
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/^rate_limit_/);
    expect(res.body.error).not.toBe("cuota_excedida");
  });
});
