/** tests/combustible-despachos.test.ts
 *
 * Fase B de combustible (ver docs/architecture/control-de-combustible.md,
 * puntos 1, 2 y 5, y migrations/0062). Cubre lo que el prompt cerrado de
 * ejecución pidió como criterio de terminado: happy path de los dos
 * orígenes, el 409 de vale duplicado, el 400 de contómetro, la validación
 * de tipo_medidor por equipo, y el motor de huecos (punto 1) como consulta
 * bajo demanda -- sin conciliación, sin anomalías, sin anulación (Fase D).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

/** `serie_talonario` tiene 20 caracteres máximo (real: "A", "SERIE-2026-03") --
 *  `idUnico()` sola (con su timestamp completo) se pasa de largo, así que
 *  las series de este archivo usan un sufijo corto en vez de esa función. */
function serieUnica(): string {
  return `S${Math.floor(Math.random() * 1e8).toString(36)}`;
}

async function crearTanque(tenantId: string, capacidadTotal = 5000): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const fila = await client.query(
      `INSERT INTO combustible (
         tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, capacidad_total
       )
       VALUES ($1, $2, 'Tanque despachos', 'diesel_b5', 'gal', 'fijo', $3) RETURNING id`,
      [tenantId, idUnico("TQ"), capacidadTotal]
    );
    return fila.rows[0].id;
  });
}

describe("combustible: despachos (Fase B)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  let tanqueId: number;
  let equipoVolquete: number; // tipo_medidor = horometro
  let equipoTrailer: number; // tipo_medidor = odometro
  let equipoSinMedidor: number; // tipo_medidor sin configurar

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    tanqueId = await crearTanque(tenantId);

    const volquete = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE", tipo_medidor: "horometro" });
    equipoVolquete = volquete.body.id;

    const trailer = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("TR"), tipo: "TRAILER", tipo_medidor: "odometro" });
    equipoTrailer = trailer.body.id;

    const sinMedidor = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("CM"), tipo: "CAMIONETA" });
    equipoSinMedidor = sinMedidor.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  function payloadTanquePropio(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoVolquete,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad: 35,
      lectura_contometro: 35,
      despachado_en: new Date().toISOString(),
      ...overrides,
    };
  }

  function payloadCompraExterna(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      origen: "compra_externa",
      grifo_externo: "PRIMAX",
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoVolquete,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad: 40,
      lectura_horometro: 9707,
      horas_abastecidas: 12,
      despachado_en: new Date().toISOString(),
      ...overrides,
    };
  }

  it("happy path tanque_propio: crea el despacho con 201", async () => {
    const res = await agente.post("/api/erp/combustible/despachos").send(payloadTanquePropio());
    expect(res.status).toBe(201);
    expect(res.body.origen).toBe("tanque_propio");
    expect(Number(res.body.combustible_id)).toBe(tanqueId);
    expect(res.body.lectura_horometro).toBeNull();
  });

  it("happy path compra_externa con horómetro: crea el despacho con 201", async () => {
    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadCompraExterna({ equipo_id: equipoVolquete }));
    expect(res.status).toBe(201);
    expect(res.body.origen).toBe("compra_externa");
    expect(res.body.combustible_id).toBeNull();
    expect(Number(res.body.lectura_horometro)).toBe(9707);
  });

  it("happy path compra_externa con odómetro (equipo medido por km): 201", async () => {
    const res = await agente.post("/api/erp/combustible/despachos").send(
      payloadCompraExterna({
        equipo_id: equipoTrailer,
        lectura_horometro: undefined,
        lectura_odometro: 31197.7,
      })
    );
    expect(res.status).toBe(201);
    expect(Number(res.body.lectura_odometro)).toBe(31197.7);
  });

  it("409: el mismo N°VALE en la misma serie no se puede repetir", async () => {
    const serie = serieUnica();
    const primero = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadTanquePropio({ serie_talonario: serie, n_vale: 7 }));
    expect(primero.status).toBe(201);

    const repetido = await agente.post("/api/erp/combustible/despachos").send(
      payloadTanquePropio({
        serie_talonario: serie,
        n_vale: 7,
        cantidad: 20,
        lectura_contometro: 20,
      })
    );
    expect(repetido.status).toBe(409);
  });

  it("el mismo N°VALE SÍ puede repetirse en una serie DISTINTA", async () => {
    const a = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadTanquePropio({ serie_talonario: serieUnica(), n_vale: 3 }));
    const b = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadTanquePropio({ serie_talonario: serieUnica(), n_vale: 3 }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("400: el contómetro no coincide con la cantidad declarada (tanque_propio)", async () => {
    const res = await agente.post("/api/erp/combustible/despachos").send(
      payloadTanquePropio({
        cantidad: 35,
        lectura_contometro: 53, // transposición de dígitos
      })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contómetro/i);
  });

  it("400: compra_externa a un equipo sin tipo_medidor configurado", async () => {
    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadCompraExterna({ equipo_id: equipoSinMedidor }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tipo de medidor/i);
  });

  it("400: un equipo que mide por horómetro no acepta lectura_odometro", async () => {
    const res = await agente.post("/api/erp/combustible/despachos").send(
      payloadCompraExterna({
        equipo_id: equipoVolquete, // horometro
        lectura_horometro: undefined,
        lectura_odometro: 12345,
      })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/horómetro/i);
  });

  it("400 (Zod): compra_externa exige tipo_destino='equipo' -- no tiene sentido sin equipo", async () => {
    const res = await agente.post("/api/erp/combustible/despachos").send(
      payloadCompraExterna({
        tipo_destino: "planta",
        equipo_id: undefined,
      })
    );
    expect(res.status).toBe(400);
  });

  it("400 (Zod): tanque_propio sin combustible_id", async () => {
    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadTanquePropio({ combustible_id: undefined }));
    expect(res.status).toBe(400);
  });

  it("400 (Zod): tipo_destino='equipo' exige equipo_id", async () => {
    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadTanquePropio({ equipo_id: undefined }));
    expect(res.status).toBe(400);
  });

  it("cliente_uuid repetido no duplica el despacho (cola offline)", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = payloadTanquePropio({ cliente_uuid: clienteUuid, n_vale: 99 });

    const primera = await agente.post("/api/erp/combustible/despachos").send(cuerpo);
    expect(primera.status).toBe(201);

    const reintento = await agente.post("/api/erp/combustible/despachos").send(cuerpo);
    expect(reintento.status).toBe(200);
    expect(reintento.body.id).toBe(primera.body.id);

    const total = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM combustible_despachos
         WHERE tenant_id = $1 AND serie_talonario = $2 AND n_vale = 99`,
        [tenantId, cuerpo.serie_talonario]
      )
    );
    expect(total.rows[0].total).toBe(1);
  });

  describe("GET /despachos/huecos -- consulta bajo demanda (punto 1)", () => {
    it("detecta el hueco correcto dentro de una serie, sin tocar otras series", async () => {
      const serie = serieUnica();
      for (const nVale of [1, 2, 4]) {
        const res = await agente
          .post("/api/erp/combustible/despachos")
          .send(payloadTanquePropio({ serie_talonario: serie, n_vale: nVale }));
        expect(res.status).toBe(201);
      }

      const huecos = await agente.get(
        `/api/erp/combustible/despachos/huecos?serie_talonario=${serie}`
      );
      expect(huecos.status).toBe(200);
      expect(huecos.body).toEqual({ serie, huecos: [3], ultimo: 4 });
    });

    it("una serie sin ningún vale devuelve huecos vacíos y ultimo null", async () => {
      const res = await agente.get(
        `/api/erp/combustible/despachos/huecos?serie_talonario=${serieUnica()}`
      );
      expect(res.status).toBe(200);
      expect(res.body.huecos).toEqual([]);
      expect(res.body.ultimo).toBeNull();
    });

    it("400 si falta el query param serie_talonario", async () => {
      const res = await agente.get("/api/erp/combustible/despachos/huecos");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /despachos -- listado", () => {
    it("filtra por equipo_id", async () => {
      const serie = serieUnica();
      await agente
        .post("/api/erp/combustible/despachos")
        .send(
          payloadTanquePropio({ serie_talonario: serie, n_vale: 1, equipo_id: equipoVolquete })
        );
      await agente
        .post("/api/erp/combustible/despachos")
        .send(payloadTanquePropio({ serie_talonario: serie, n_vale: 2, equipo_id: equipoTrailer }));

      const res = await agente.get(`/api/erp/combustible/despachos?equipo_id=${equipoTrailer}`);
      expect(res.status).toBe(200);
      expect(
        res.body.data.every((d: { equipo_id: number }) => Number(d.equipo_id) === equipoTrailer)
      ).toBe(true);
      expect(
        res.body.data.some((d: { serie_talonario: string }) => d.serie_talonario === serie)
      ).toBe(true);
    });
  });
});
