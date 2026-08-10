/** tests/eventos-tiempo-real.test.ts
 *
 * Canal de tiempo real (SSE + Redis pub/sub, migración 0042, ver
 * realtimeEvents.service.ts). No se testea "conectar un EventSource real
 * y recibir un mensaje" por HTTP -- una respuesta SSE nunca termina sola,
 * así que ese estilo de test queda frágil (hay que forzar el cierre del
 * socket a mano). En su lugar:
 *   - el límite de auth se prueba por HTTP (ahí sí hay una respuesta
 *     normal, el middleware corta antes de abrir el stream),
 *   - el replay y el fan-out de Redis se prueban contra las funciones de
 *     servicio directamente -- son las mismas que usa el handler SSE.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import Redis from "ioredis";
import {
  app,
  crearTenantDePrueba,
  borrarTenantDePrueba,
  idUnico,
  redisDisponible,
} from "./helpers";
import { pool, withTenant, closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import {
  publicarEventoTenant,
  publicarEventoPlataforma,
  reponerEventosTenant,
  reponerEventosPlataforma,
  suscribirCanal,
  canalDeTenant,
} from "../src/server/services/realtimeEvents.service";
import { limpiarEventosTiempoRealViejos } from "../src/server/services/eventosTiempoRealRetention.worker";
import {
  registrarConexionSSE,
  quitarConexionSSE,
  cerrarConexionesSSE,
} from "../src/server/shared/utils/sseRegistry";
import type { Response as ExpressResponse } from "express";

afterAll(async () => {
  await closeDatabase();
});

/** publicarEventoTenant/Plataforma nunca lanzan (ver el comentario en
 *  realtimeEvents.service.ts) -- en condiciones normales de test siempre
 *  hay valor, esto solo hace explícito ese supuesto en vez de forzar el
 *  tipo con `!`. */
function asDefinido<T>(valor: T | undefined): T {
  expect(valor).toBeDefined();
  return valor as T;
}

// ═══════════════════════════════════════════════════════════════════════
// Auth
// ═══════════════════════════════════════════════════════════════════════

describe("GET /api/eventos/stream", () => {
  it("sin sesión de tenant: 401, nunca abre el stream", async () => {
    const res = await request(app).get("/api/eventos/stream");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/platform/eventos/stream", () => {
  it("sin credencial de plataforma: 401", async () => {
    const res = await request(app).get("/api/platform/eventos/stream");
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Replay (Last-Event-ID) -- y de paso, que la RLS de eventos_tiempo_real
// aísla entre tenants incluso para este camino de lectura nuevo.
// ═══════════════════════════════════════════════════════════════════════

describe("reponerEventosTenant / reponerEventosPlataforma", () => {
  it("un tenant solo repone sus propios eventos, nunca los de otro tenant", async () => {
    const tenantA = await crearTenantDePrueba();
    const tenantB = await crearTenantDePrueba();

    try {
      const eventoA = asDefinido(
        await publicarEventoTenant(tenantA.tenant.id, "checklist.actualizado", {
          checklistId: idUnico("chk"),
        })
      );
      await publicarEventoTenant(tenantB.tenant.id, "checklist.actualizado", {
        checklistId: idUnico("chk"),
      });

      const repuestosDesdeA = await reponerEventosTenant(tenantA.tenant.id, 0);
      expect(repuestosDesdeA.map((e) => e.id)).toContain(eventoA.id);
      expect(repuestosDesdeA.every((e) => e.tipo === "checklist.actualizado")).toBe(true);

      // El punto central del test: sin filtrar por tenant_id en el SQL de
      // reponerEventosTenant (usa withTenant(), RLS filtra sola) -- si la
      // policy no estuviera, esta lista tendría también el evento de B.
      const soloIdsDeB = (await reponerEventosTenant(tenantB.tenant.id, 0)).map((e) => e.id);
      expect(repuestosDesdeA.map((e) => e.id)).not.toEqual(expect.arrayContaining(soloIdsDeB));
    } finally {
      await borrarTenantDePrueba(tenantA.tenant.id);
      await borrarTenantDePrueba(tenantB.tenant.id);
    }
  });

  it("respeta Last-Event-ID: solo repone lo posterior al id dado", async () => {
    const tenant = await crearTenantDePrueba();
    try {
      const primero = asDefinido(
        await publicarEventoTenant(tenant.tenant.id, "equipo.creado", { n: 1 })
      );
      const segundo = asDefinido(
        await publicarEventoTenant(tenant.tenant.id, "equipo.creado", { n: 2 })
      );

      const soloElSegundo = await reponerEventosTenant(tenant.tenant.id, Number(primero.id));
      expect(soloElSegundo.map((e) => e.id)).not.toContain(primero.id);
      expect(soloElSegundo.map((e) => e.id)).toContain(segundo.id);
    } finally {
      await borrarTenantDePrueba(tenant.tenant.id);
    }
  });

  it("plataforma: repone eventos de plataforma sin necesitar tenant", async () => {
    const evento = asDefinido(
      await publicarEventoPlataforma("tenant.cuota_agotada", { tenantSlug: "acme" })
    );
    const repuestos = await reponerEventosPlataforma(Number(evento.id) - 1);
    expect(repuestos.map((e) => e.id)).toContain(evento.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Fan-out por Redis pub/sub -- simula dos instancias del server: una
// publica (publicarEventoTenant, usa el cliente de comandos de la app),
// otra "instancia" tiene su PROPIA conexión de suscripción a Redis,
// independiente de la que arma el broker interno de la app. Si esto
// recibe el mensaje, el fan-out entre procesos funciona de verdad.
// ═══════════════════════════════════════════════════════════════════════

const conRedis = await redisDisponible();

function nuevaConexionRedis() {
  return env.redisUrl
    ? new Redis(env.redisUrl)
    : new Redis({
        host: env.redisHost,
        port: env.redisPort,
        password: env.redisPassword || undefined,
      });
}

describe("fan-out en vivo vía Redis pub/sub", () => {
  it.runIf(conRedis)(
    "una conexión de suscripción independiente (otra instancia simulada) recibe lo publicado",
    async () => {
      const tenant = await crearTenantDePrueba();
      const otraInstancia = nuevaConexionRedis();

      try {
        const canal = canalDeTenant(tenant.tenant.id);
        const mensajeRecibido = new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("timeout esperando el mensaje")), 5000);
          otraInstancia.on("message", (canalRecibido, mensaje) => {
            if (canalRecibido === canal) {
              clearTimeout(timeout);
              resolve(mensaje);
            }
          });
        });
        await otraInstancia.subscribe(canal);

        const publicado = asDefinido(
          await publicarEventoTenant(tenant.tenant.id, "repuesto.stock_bajo", {
            repuestoId: idUnico("rep"),
          })
        );

        const mensaje = JSON.parse(await mensajeRecibido);
        expect(mensaje.id).toBe(publicado.id);
        expect(mensaje.tipo).toBe("repuesto.stock_bajo");
      } finally {
        await otraInstancia.quit();
        await borrarTenantDePrueba(tenant.tenant.id);
      }
    }
  );

  it.runIf(conRedis)(
    "suscribirCanal (broker interno) recibe y desuscribirse deja de recibir",
    async () => {
      const tenant = await crearTenantDePrueba();
      try {
        const canal = canalDeTenant(tenant.tenant.id);
        const recibidos: unknown[] = [];
        const desuscribir = await suscribirCanal(canal, (mensajeCrudo) => {
          recibidos.push(JSON.parse(mensajeCrudo));
        });

        await publicarEventoTenant(tenant.tenant.id, "documento.vencido", { doc: 1 });
        await vi.waitFor(() => expect(recibidos).toHaveLength(1));

        desuscribir();
        await publicarEventoTenant(tenant.tenant.id, "documento.vencido", { doc: 2 });
        // Nada nuevo debería llegar tras desuscribirse -- se espera un
        // instante y se confirma que la lista no creció.
        await new Promise((r) => setTimeout(r, 300));
        expect(recibidos).toHaveLength(1);
      } finally {
        await borrarTenantDePrueba(tenant.tenant.id);
      }
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Cierre de conexiones SSE en shutdown (sseRegistry.ts)
// ═══════════════════════════════════════════════════════════════════════

describe("sseRegistry: shutdown gracioso", () => {
  it("cerrarConexionesSSE termina cada conexión activa y vacía el registro", () => {
    const resA = { end: vi.fn() } as unknown as ExpressResponse;
    const resB = { end: vi.fn() } as unknown as ExpressResponse;

    registrarConexionSSE(resA);
    registrarConexionSSE(resB);

    cerrarConexionesSSE();

    expect(resA.end).toHaveBeenCalledTimes(1);
    expect(resB.end).toHaveBeenCalledTimes(1);

    // El registro quedó vacío: una segunda corrida (ej. un signal
    // duplicado) no vuelve a llamar end() sobre las mismas respuestas.
    cerrarConexionesSSE();
    expect(resA.end).toHaveBeenCalledTimes(1);
    expect(resB.end).toHaveBeenCalledTimes(1);
  });

  it("quitarConexionSSE saca una conexión puntual sin afectar al resto", () => {
    const resA = { end: vi.fn() } as unknown as ExpressResponse;
    const resB = { end: vi.fn() } as unknown as ExpressResponse;

    registrarConexionSSE(resA);
    registrarConexionSSE(resB);
    quitarConexionSSE(resA);

    cerrarConexionesSSE();

    expect(resA.end).not.toHaveBeenCalled();
    expect(resB.end).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Retención (eventosTiempoRealRetention.worker.ts) -- mismo patrón que
// tests/platform-audit-retention.test.ts, pero acá el default de la app
// va ENCENDIDO (60 min), no apagado: es un buffer, no un histórico de
// compliance. Por eso no hay un test de "sin retentionMinutes no borra
// nada" -- sería probar lo contrario de lo que el default hace a propósito.
// ═══════════════════════════════════════════════════════════════════════

describe("limpiarEventosTiempoRealViejos", () => {
  async function insertarEventoTenantConFecha(tenantId: string, minutosAtras: number) {
    const { rows } = await withTenant(tenantId, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO eventos_tiempo_real (tenant_id, tipo, payload, creado_en)
         VALUES ($1, 'test.retencion', '{}'::jsonb, now() - make_interval(mins => $2))
         RETURNING id`,
        [tenantId, minutosAtras]
      )
    );
    return rows[0].id;
  }

  async function insertarEventoPlataformaConFecha(minutosAtras: number) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO platform_eventos_tiempo_real (tipo, payload, creado_en)
       VALUES ('test.retencion', '{}'::jsonb, now() - make_interval(mins => $1))
       RETURNING id`,
      [minutosAtras]
    );
    return rows[0].id;
  }

  it("borra eventos de tenant más viejos que la retención y deja los recientes", async () => {
    const tenant = await crearTenantDePrueba();
    try {
      const vieja = await insertarEventoTenantConFecha(tenant.tenant.id, 400);
      const nueva = await insertarEventoTenantConFecha(tenant.tenant.id, 0);

      const { filasBorradas } = await limpiarEventosTiempoRealViejos({ retentionMinutes: 60 });
      expect(filasBorradas).toBeGreaterThanOrEqual(1);

      const restante = await withTenant(tenant.tenant.id, (client) =>
        client.query(`SELECT id FROM eventos_tiempo_real WHERE tenant_id = $1`, [tenant.tenant.id])
      );
      const idsRestantes = restante.rows.map((f) => f.id);
      expect(idsRestantes).not.toContain(vieja);
      expect(idsRestantes).toContain(nueva);
    } finally {
      await borrarTenantDePrueba(tenant.tenant.id);
    }
  });

  it("borra eventos de plataforma más viejos que la retención y deja los recientes", async () => {
    const vieja = await insertarEventoPlataformaConFecha(400);
    const nueva = await insertarEventoPlataformaConFecha(0);

    await limpiarEventosTiempoRealViejos({ retentionMinutes: 60 });

    const restante = await pool.query(
      `SELECT id FROM platform_eventos_tiempo_real WHERE id = ANY($1)`,
      [[vieja, nueva]]
    );
    const idsRestantes = restante.rows.map((f) => f.id);
    expect(idsRestantes).not.toContain(vieja);
    expect(idsRestantes).toContain(nueva);

    await pool.query(`DELETE FROM platform_eventos_tiempo_real WHERE id = $1`, [nueva]);
  });

  it("con retentionMinutes en 0 no borra nada", async () => {
    const vieja = await insertarEventoPlataformaConFecha(5000);

    const { filasBorradas } = await limpiarEventosTiempoRealViejos({ retentionMinutes: 0 });
    expect(filasBorradas).toBe(0);

    const restante = await pool.query(`SELECT id FROM platform_eventos_tiempo_real WHERE id = $1`, [
      vieja,
    ]);
    expect(restante.rows).toHaveLength(1);

    await pool.query(`DELETE FROM platform_eventos_tiempo_real WHERE id = $1`, [vieja]);
  });
});
