/** tests/platform-outbox.test.ts
 *
 * Outbox transaccional (migrations/0018_platform_outbox.sql). El punto
 * central a probar: la respuesta de una Idempotency-Key sobrevive aunque
 * Redis nunca la haya cacheado (antes era al revés — Redis era la única
 * fuente, escrita DESPUÉS del commit, sin garantía de que corriera), y
 * dos transacciones concurrentes con la misma key nueva no pueden
 * terminar las dos exitosas.
 *
 * La carrera concurrente se prueba a nivel de servicio
 * (crearTenantConAdminService directo), no por HTTP: sobre HTTP, si hay
 * Redis disponible, el gate de `consultarIdempotencia` ya serializa a la
 * segunda request con un 409 antes de que llegue a tocar la base — así
 * que la carrera real (dos transacciones de Postgres pisándose) nunca se
 * dispara por ese camino, y probarla por timing de red sería frágil. El
 * mecanismo que la cierra (el índice único de platform_outbox) es el
 * mismo sin importar por dónde se lo invoque.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, idUnico, borrarTenantDePrueba, redisDisponible } from "./helpers";
import { env } from "../src/server/config/env";
import { getRedis } from "../src/server/config/redis";
import { pool, closeDatabase } from "../src/server/config/database";
import { crearTenantConAdminService } from "../src/server/services/platform.service";
import { consultarIdempotencia } from "../src/server/services/platformIdempotency.service";
import {
  escribirEventoOutbox,
  reclamarPendientes,
  marcarFallo,
} from "../src/server/services/platformOutbox.service";
import { drenarUnaVez } from "../src/server/services/platformOutbox.worker";
import type { ContextoAuditoria } from "../src/server/services/platformAudit.service";

const BEARER = `Bearer ${env.platformAdminToken}`;
const CONTEXTO: ContextoAuditoria = {
  ip: "127.0.0.1",
  actorType: "emergency_shared_secret",
  actorLabel: "test",
};
const tenantIdsCreados: string[] = [];

function bodyTenant(slug: string) {
  return {
    tenantNombre: `Outbox ${slug}`,
    tenantSlug: slug,
    adminNombre: "Admin de prueba",
    adminEmail: `${slug}@test.local`,
    adminPassword: "ClaveDePrueba123",
  };
}

const conRedis = await redisDisponible();

afterAll(async () => {
  for (const id of tenantIdsCreados) {
    await borrarTenantDePrueba(id).catch(() => {});
  }
  await closeDatabase();
});

describe("durabilidad de Idempotency-Key en platform_outbox (independiente de Redis)", () => {
  it("consultarIdempotencia encuentra la respuesta en platform_outbox aunque Redis nunca la haya cacheado", async () => {
    const idempotencyKey = idUnico("solo-outbox");
    const slug = idUnico("solo-outbox-tenant");

    const resultado = await crearTenantConAdminService(bodyTenant(slug), CONTEXTO, idempotencyKey);
    tenantIdsCreados.push(resultado.tenant.id);

    // Nada tocó Redis en el medio — la única escritura fue el evento de
    // outbox, dentro de la misma transacción que el tenant.
    const estado = await consultarIdempotencia(idempotencyKey);
    expect(estado.estado).toBe("resuelta");
    if (estado.estado === "resuelta") {
      expect((estado.respuesta as any).tenant.id).toBe(resultado.tenant.id);
    }
  });

  it("retry por HTTP con la misma Idempotency-Key y el mismo body devuelve la respuesta original, no un 409 de slug duplicado", async () => {
    const idempotencyKey = idUnico("retry-http");
    const slug = idUnico("retry-http-tenant");
    const body = bodyTenant(slug);

    const primera = await request(app)
      .post("/api/platform/tenants")
      .set("Authorization", BEARER)
      .set("Idempotency-Key", idempotencyKey)
      .send(body);
    expect(primera.status).toBe(201);
    tenantIdsCreados.push(primera.body.tenant.id);

    // Simula un cliente que reintenta porque no vio la respuesta original
    // (timeout, crash del cliente, lo que sea) — mismo body, misma key.
    const segunda = await request(app)
      .post("/api/platform/tenants")
      .set("Authorization", BEARER)
      .set("Idempotency-Key", idempotencyKey)
      .send(body);
    expect(segunda.status).toBe(201);
    expect(segunda.body.tenant.id).toBe(primera.body.tenant.id);

    const filas = await pool.query(`SELECT id FROM tenants WHERE slug = $1`, [slug]);
    expect(filas.rows).toHaveLength(1);
  });
});

describe("cierre de la carrera concurrente (índice único de platform_outbox)", () => {
  it("dos creaciones concurrentes con la misma Idempotency-Key nunca vista (slugs distintos): solo una gana, la otra se revierte entera", async () => {
    const idempotencyKey = idUnico("carrera");
    const slugA = idUnico("carrera-a");
    const slugB = idUnico("carrera-b");

    const [resA, resB] = await Promise.allSettled([
      crearTenantConAdminService(bodyTenant(slugA), CONTEXTO, idempotencyKey),
      crearTenantConAdminService(bodyTenant(slugB), CONTEXTO, idempotencyKey),
    ]);

    const ganadora = [resA, resB].find((r) => r.status === "fulfilled");
    const perdedora = [resA, resB].find((r) => r.status === "rejected");
    expect(ganadora).toBeDefined();
    expect(perdedora).toBeDefined(); // la transacción que pierde se revierte entera, tenant incluido

    // Nunca quedan los dos tenants, aunque tuvieran slugs distintos — el
    // UNIQUE(slug) por sí solo no habría evitado esto, hacían falta dos
    // slugs distintos justamente para aislar que es el outbox el que corta.
    const filas = await pool.query(`SELECT id FROM tenants WHERE slug IN ($1, $2)`, [slugA, slugB]);
    expect(filas.rows).toHaveLength(1);

    if (ganadora?.status === "fulfilled") {
      tenantIdsCreados.push((ganadora.value as { tenant: { id: string } }).tenant.id);
    }
  });
});

describe("platformOutbox.worker: drenarUnaVez", () => {
  it("procesa un evento pendiente y lo marca 'procesado'", async () => {
    const marca = idUnico("worker-prueba");
    await escribirEventoOutbox(pool, { tipo: "alerta_rafaga", payload: { marca } });

    await drenarUnaVez();

    const fila = await pool.query(
      `SELECT estado FROM platform_outbox WHERE tipo = 'alerta_rafaga' AND payload->>'marca' = $1`,
      [marca]
    );
    expect(fila.rows).toHaveLength(1);
    expect(fila.rows[0].estado).toBe("procesado");
  });

  it.skipIf(!conRedis)(
    "con Redis real: puebla el cache de una respuesta idempotente ya durable en el outbox",
    async () => {
      const idempotencyKey = idUnico("worker-redis");
      const slug = idUnico("worker-redis-tenant");

      const resultado = await crearTenantConAdminService(
        bodyTenant(slug),
        CONTEXTO,
        idempotencyKey
      );
      tenantIdsCreados.push(resultado.tenant.id);

      await drenarUnaVez();

      const redis = getRedis()!;
      const crudo = await redis.get(`platform-idempotency:crear-tenant:${idempotencyKey}`);
      expect(crudo).not.toBeNull();
      const parsed = JSON.parse(crudo as string);
      expect(parsed.estado).toBe("resuelta");
      expect(parsed.respuesta.tenant.id).toBe(resultado.tenant.id);
    }
  );
});

describe("reclamarPendientes: lease + backoff (multi-instancia)", () => {
  it("un evento recién reclamado no vuelve a salir en un segundo reclamo inmediato (lease todavía vigente)", async () => {
    const marca = idUnico("lease");
    await escribirEventoOutbox(pool, { tipo: "alerta_rafaga", payload: { marca } });

    const primerLote = await reclamarPendientes(50);
    const propio = primerLote.find((e) => (e.payload as any).marca === marca);
    expect(propio).toBeDefined();

    // Mismo poll, sin que el handler haya corrido todavía (simula dos
    // instancias del worker reclamando casi al mismo tiempo, o un segundo
    // poll antes de que termine el primero): el evento no puede volver a
    // salir mientras el lease de la primera reclamación siga vigente.
    const segundoLote = await reclamarPendientes(50);
    expect(segundoLote.find((e) => (e.payload as any).marca === marca)).toBeUndefined();

    await marcarProcesadoDePrueba(propio!.id);
  });

  it("marcarFallo guarda ultimo_error y aplica backoff (disponible_en queda en el futuro)", async () => {
    const marca = idUnico("fallo");
    await escribirEventoOutbox(pool, { tipo: "alerta_rafaga", payload: { marca } });

    const [evento] = await reclamarPendientes(1000).then((lote) =>
      lote.filter((e) => (e.payload as any).marca === marca)
    );
    await marcarFallo(evento.id, evento.intentos, "boom: fallo simulado");

    const fila = await pool.query(
      `SELECT estado, intentos, ultimo_error, disponible_en > now() AS "backoffFuturo"
       FROM platform_outbox WHERE id = $1`,
      [evento.id]
    );
    expect(fila.rows[0].estado).toBe("pendiente");
    expect(fila.rows[0].intentos).toBe(1);
    expect(fila.rows[0].ultimo_error).toBe("boom: fallo simulado");
    expect(fila.rows[0].backoffFuturo).toBe(true);

    // Con disponible_en en el futuro, no debería reclamarse de nuevo todavía.
    const lote = await reclamarPendientes(1000);
    expect(lote.find((e) => e.id === evento.id)).toBeUndefined();
  });

  it("tras MAX_INTENTOS fallos consecutivos, el evento pasa a 'fallido' y el worker deja de reintentarlo", async () => {
    const marca = idUnico("agotado");
    await escribirEventoOutbox(pool, { tipo: "alerta_rafaga", payload: { marca } });
    const [evento] = await reclamarPendientes(1000).then((lote) =>
      lote.filter((e) => (e.payload as any).marca === marca)
    );

    for (let intentos = 0; intentos < 5; intentos++) {
      await marcarFallo(evento.id, intentos, `intento ${intentos}`);
    }

    const fila = await pool.query(`SELECT estado, intentos FROM platform_outbox WHERE id = $1`, [
      evento.id,
    ]);
    expect(fila.rows[0].estado).toBe("fallido");
    expect(fila.rows[0].intentos).toBe(5);
  });
});

async function marcarProcesadoDePrueba(id: string): Promise<void> {
  await pool.query(
    `UPDATE platform_outbox SET estado = 'procesado', procesado_en = now() WHERE id = $1`,
    [id]
  );
}
