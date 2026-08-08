/** tests/erp-rate-limit.test.ts
 *
 * Rate limit de /api/erp/* en dos niveles (middleware/erpRateLimiter.ts +
 * platformRateLimitCuota.ts). Ver docs/architecture/cuotas-por-tenant.md.
 *
 * Tres propiedades que hacen que este diseño sirva y que no son obvias:
 *
 *   1. Se cuenta por USUARIO, no por IP. En este despliegue la IP no
 *      identifica a nadie: los de oficina comparten el NAT de la empresa y
 *      los de planta usan datos móviles (CGNAT + IP cambiante). Dos usuarios
 *      del mismo tenant, desde la misma IP, deben tener presupuestos
 *      separados.
 *
 *   2. Un usuario que choca contra su fusible NO consume el presupuesto del
 *      tenant, o un script descontrolado bloquearía a sus compañeros.
 *
 *   3. El techo del tenant se cachea (Redis, TTL 300s) para no consultar
 *      Postgres en cada request — pero se invalida al guardarlo, o cambiarlo
 *      en el panel no tendría efecto por 5 minutos.
 *
 * El fusible personal se ajusta mutando `env` (el middleware lo lee en cada
 * request); el techo del tenant, guardando el override real en la base, que
 * es como funciona en producción.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { env } from "../src/server/config/env";
import { closeDatabase } from "../src/server/config/database";
import { fijarCuotaTenant } from "../src/server/services/platformCuotas.service";
import {
  RECURSO_RATE_LIMIT,
  resolverRateLimitTenant,
} from "../src/server/services/platformRateLimitCuota";

const password = "ClaveDePrueba123";
const BEARER = `Bearer ${env.platformAdminToken}`;
const tenantsCreados: string[] = [];
const usuarioMaxOriginal = env.erpRateLimitUsuarioMax;
const tenantDefaultOriginal = env.erpRateLimitTenantDefault;

async function nuevoTenantConAgente() {
  const { tenant, usuario } = await crearTenantDePrueba(password);
  tenantsCreados.push(tenant.id);
  const agente = request.agent(app);
  await agente
    .post("/api/auth/login")
    .send({ tenantSlug: tenant.slug, email: usuario.email, password });
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

/** El techo del tenant es un override real en tenant_cuotas, igual que en
 *  producción — no una variable de entorno. `fijarCuotaTenant` invalida el
 *  caché sola, que es justamente parte de lo que hay que probar. */
async function fijarTecho(tenantId: string, rpm: number | null | undefined) {
  await fijarCuotaTenant(tenantId, RECURSO_RATE_LIMIT, rpm, "test");
}

beforeEach(() => {
  env.erpRateLimitWindowMs = 60_000; // ventana larga: nada expira a mitad de un test
  env.erpRateLimitUsuarioMax = 100000;
  env.erpRateLimitTenantDefault = 100000;
});

afterEach(() => {
  env.erpRateLimitUsuarioMax = usuarioMaxOriginal;
  env.erpRateLimitTenantDefault = tenantDefaultOriginal;
});

afterAll(async () => {
  env.erpRateLimitUsuarioMax = usuarioMaxOriginal;
  env.erpRateLimitTenantDefault = tenantDefaultOriginal;
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
    const creacion = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EQ"), tipo: "Camioneta" });
    expect(creacion.status).toBe(429);
  });
});

describe("nivel 2: techo del tenant, resuelto en dos capas", () => {
  it("sin override usa el fallback global", async () => {
    const { tenant } = await nuevoTenantConAgente();
    env.erpRateLimitTenantDefault = 4321;

    expect(await resolverRateLimitTenant(tenant.id)).toBe(4321);
  });

  it("un override en tenant_cuotas manda sobre el fallback global", async () => {
    const { tenant } = await nuevoTenantConAgente();
    env.erpRateLimitTenantDefault = 4321;
    await fijarTecho(tenant.id, 77);

    expect(await resolverRateLimitTenant(tenant.id)).toBe(77);
  });

  it("borrar el override devuelve el tenant al fallback global", async () => {
    const { tenant } = await nuevoTenantConAgente();
    env.erpRateLimitTenantDefault = 4321;
    await fijarTecho(tenant.id, 77);
    expect(await resolverRateLimitTenant(tenant.id)).toBe(77);

    await fijarTecho(tenant.id, undefined); // borra la fila
    expect(await resolverRateLimitTenant(tenant.id)).toBe(4321);
  });

  it("un override en NULL significa SIN TECHO, no 'usá el default'", async () => {
    // Si `null` se confundiera con ausencia, el tenant caería al fallback y
    // terminaría con un tope que alguien quitó a propósito.
    const { tenant } = await nuevoTenantConAgente();
    env.erpRateLimitTenantDefault = 4321;
    await fijarTecho(tenant.id, null);

    expect(await resolverRateLimitTenant(tenant.id)).toBeNull();
  });

  it("el override efectivamente bloquea, con nivel 'tenant' y un mensaje distinto al personal", async () => {
    const { agente, tenant } = await nuevoTenantConAgente();
    await fijarTecho(tenant.id, 2);

    await agente.get("/api/erp/equipos");
    await agente.get("/api/erp/equipos");

    const bloqueado = await agente.get("/api/erp/equipos");
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.error).toBe("rate_limit_tenant");
    expect(bloqueado.body.nivel).toBe("tenant");
    // Uno se arregla esperando, el otro es señal de que la empresa necesita
    // atención: los mensajes tienen que ser distintos.
    expect(bloqueado.body.message).toMatch(/empresa/i);
  });

  it("alcanza a TODOS los usuarios del tenant, aunque cada uno tenga cupo personal de sobra", async () => {
    const { agente: primero, tenant } = await nuevoTenantConAgente();
    const segundo = await segundoUsuarioDe(tenant);
    env.erpRateLimitUsuarioMax = 100; // el fusible personal no se toca
    await fijarTecho(tenant.id, 2);

    await primero.get("/api/erp/equipos");
    await primero.get("/api/erp/equipos");

    const bloqueado = await segundo.get("/api/erp/equipos");
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.nivel).toBe("tenant");
  });

  it("DOS tenants con límites distintos funcionan en paralelo", async () => {
    const a = await nuevoTenantConAgente();
    const b = await nuevoTenantConAgente();
    await fijarTecho(a.tenant.id, 2); // apretado
    await fijarTecho(b.tenant.id, 50); // holgado

    await a.agente.get("/api/erp/equipos");
    await a.agente.get("/api/erp/equipos");
    expect((await a.agente.get("/api/erp/equipos")).status).toBe(429);

    // B tiene su propio número y sigue trabajando.
    for (let i = 0; i < 5; i++) {
      expect((await b.agente.get("/api/erp/equipos")).status).toBe(200);
    }
  });
});

describe("caché del techo e invalidación", () => {
  it("cambiar el límite tiene efecto INMEDIATO, no cuando vence el TTL", async () => {
    // Sin invalidación explícita, el admin cambiaría el límite en el panel,
    // no pasaría nada por 5 minutos, y volvería a cambiarlo pensando que
    // falló. Este test es el que protege contra eso.
    const { agente, tenant } = await nuevoTenantConAgente();
    await fijarTecho(tenant.id, 100);

    // Un request primero, para que el valor quede cacheado.
    expect((await agente.get("/api/erp/equipos")).status).toBe(200);
    expect(await resolverRateLimitTenant(tenant.id)).toBe(100);

    // Se baja el techo: la invalidación tiene que hacerlo visible ya.
    await fijarTecho(tenant.id, 1);
    expect(await resolverRateLimitTenant(tenant.id)).toBe(1);
  });

  it("la invalidación también aplica al guardar desde el endpoint del panel", async () => {
    const { tenant } = await nuevoTenantConAgente();
    await fijarTecho(tenant.id, 500);
    expect(await resolverRateLimitTenant(tenant.id)).toBe(500);

    const res = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/cuotas`)
      .set("Authorization", BEARER)
      .send({ recurso: RECURSO_RATE_LIMIT, limite: 900, motivo: "ajuste comercial" });
    expect(res.status).toBe(200);

    expect(await resolverRateLimitTenant(tenant.id)).toBe(900);
  });

  it("el caché no mezcla tenants", async () => {
    const a = await nuevoTenantConAgente();
    const b = await nuevoTenantConAgente();
    await fijarTecho(a.tenant.id, 11);
    await fijarTecho(b.tenant.id, 22);

    expect(await resolverRateLimitTenant(a.tenant.id)).toBe(11);
    expect(await resolverRateLimitTenant(b.tenant.id)).toBe(22);
    // Y de nuevo, ya cacheados, para descartar que la segunda lectura pise
    // la primera.
    expect(await resolverRateLimitTenant(a.tenant.id)).toBe(11);
  });
});

describe("interacción entre los dos niveles", () => {
  it("un usuario bloqueado por su fusible NO consume el presupuesto del tenant", async () => {
    // La propiedad menos obvia y la más importante: si los requests
    // rechazados del nivel 1 contaran para el nivel 2, un solo script
    // descontrolado se comería el presupuesto de toda la empresa y
    // terminaría bloqueando a sus compañeros.
    const { agente: descontrolado, tenant } = await nuevoTenantConAgente();
    const companiero = await segundoUsuarioDe(tenant);

    env.erpRateLimitUsuarioMax = 2;
    await fijarTecho(tenant.id, 6);

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
    const { agente, tenant } = await nuevoTenantConAgente();
    env.erpRateLimitUsuarioMax = 1;
    await fijarTecho(tenant.id, 1);

    await agente.get("/api/erp/equipos");
    // Los dos en 1: debe reportarse el personal, que es el más específico y
    // accionable para quien recibe el error.
    expect((await agente.get("/api/erp/equipos")).body.nivel).toBe("usuario");
  });
});

describe("sugerencia para el panel", () => {
  it("GET /cuotas devuelve el límite vigente y una sugerencia con su justificación", async () => {
    const { tenant } = await nuevoTenantConAgente();
    env.erpRateLimitTenantDefault = 3000;

    const res = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/cuotas`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.rateLimit.recurso).toBe(RECURSO_RATE_LIMIT);
    expect(res.body.rateLimit.limiteRpm).toBe(3000); // sin override: el fallback
    expect(res.body.rateLimit.usuariosActivos).toBeGreaterThanOrEqual(1);
    // El motivo tiene que explicar de dónde sale el número: el objetivo del
    // diseño es que el límite sea explicable, no una fórmula opaca.
    expect(typeof res.body.rateLimit.motivo).toBe("string");
    expect(res.body.rateLimit.motivo.length).toBeGreaterThan(0);
  });

  it("la sugerencia nunca queda por debajo del fallback global", async () => {
    // Un tenant chico no debe recibir una sugerencia que le RECORTE el
    // límite con el que hoy funciona bien.
    const { tenant } = await nuevoTenantConAgente();
    env.erpRateLimitTenantDefault = 3000;

    const res = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/cuotas`)
      .set("Authorization", BEARER);
    expect(res.body.rateLimit.limiteSugeridoRpm).toBeGreaterThanOrEqual(3000);
  });

  it("el límite vigente refleja el override cuando existe", async () => {
    const { tenant } = await nuevoTenantConAgente();
    await fijarTecho(tenant.id, 7777);

    const res = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/cuotas`)
      .set("Authorization", BEARER);
    expect(res.body.rateLimit.limiteRpm).toBe(7777);
  });

  it("el rate limit NO aparece en la tabla de cuotas de volumen", async () => {
    // Un ritmo (req/min) y un acumulado no pertenecen a la misma tabla: la
    // columna "uso" no significa nada para el primero.
    const { tenant } = await nuevoTenantConAgente();
    const res = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/cuotas`)
      .set("Authorization", BEARER);

    expect(res.body.cuotas.some((c: any) => c.recurso === RECURSO_RATE_LIMIT)).toBe(false);
  });
});

describe("configuración", () => {
  it("cada nivel se desactiva por separado con 0", async () => {
    const { agente, tenant } = await nuevoTenantConAgente();
    env.erpRateLimitUsuarioMax = 0; // sin fusible personal
    await fijarTecho(tenant.id, 2);

    await agente.get("/api/erp/equipos");
    await agente.get("/api/erp/equipos");
    expect((await agente.get("/api/erp/equipos")).body.nivel).toBe("tenant");
  });

  it("sin techo (null) el tenant solo queda limitado por el fusible personal", async () => {
    const { agente, tenant } = await nuevoTenantConAgente();
    env.erpRateLimitUsuarioMax = 3;
    await fijarTecho(tenant.id, null);

    for (let i = 0; i < 3; i++) {
      expect((await agente.get("/api/erp/equipos")).status).toBe(200);
    }
    expect((await agente.get("/api/erp/equipos")).body.nivel).toBe("usuario");
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
