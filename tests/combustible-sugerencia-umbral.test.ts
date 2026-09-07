/** tests/combustible-sugerencia-umbral.test.ts
 *
 * El asistente de calibración. Nació para `umbral_diferencia_pct` (migración
 * 0066) y desde el PR de los tres umbrales sugiere también los dos de
 * descuadre -- la respuesta pasó de ser la sugerencia suelta a
 * `{ diferencia, descuadre, ciclo }`. Nunca guarda nada solo -- devuelve un número sugerido
 * MÁS la muestra completa que lo justifica, para que un admin la revise
 * antes de aceptarlo (ver el comentario largo de
 * CombustibleService.sugerirUmbralDiferencia).
 *
 * La fórmula (promedio de |diferencia_pct| + 2 desvíos, piso 1%) se prueba
 * con una muestra de valores elegidos a mano, no aleatorios, para poder
 * comparar contra el cálculo esperado.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { crearUsuarioService } from "../src/server/services/auth.service";
import { closeDatabase, withTenant } from "../src/server/config/database";

const HORA = 3600 * 1000;

describe("combustible: asistente de calibración de umbral (Fase D, entrega 3)", () => {
  let tenantId: string;
  let tenantSlug: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function crearTanqueYGrifo() {
    const tanque = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque calibración",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 100000,
      nivel_actual: 10000,
      requiere_documento: false,
    });
    const grifo = await agente
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("CIST") });
    return { tanqueId: tanque.body.id as number, grifoId: grifo.body.id as number };
  }

  /** Arma `n` recepciones encadenadas lectura-recepción-lectura, cada una
   *  con una diferencia (en litros) elegida a mano vía `diferenciasLitros`.
   *  Devuelve los ids de las recepciones creadas, en orden. */
  async function construirMuestra(
    tanqueId: number,
    grifoId: number,
    diferenciasLitros: number[],
    nivelInicial = 10000,
    inicioMs = Date.now() - diferenciasLitros.length * 3 * HORA
  ) {
    const CANTIDAD = 1000;
    let nivel = nivelInicial;
    const recepcionIds: number[] = [];

    await agente.post("/api/erp/combustible/lecturas").send({
      combustible_id: tanqueId,
      nivel,
      leido_en: new Date(inicioMs).toISOString(),
    });

    for (let i = 0; i < diferenciasLitros.length; i++) {
      const tRecepcion = inicioMs + (i * 2 + 1) * HORA;
      const tDespues = inicioMs + (i + 1) * 2 * HORA;

      const recepcion = await agente.post("/api/erp/combustible/recepciones").send({
        combustible_id: tanqueId,
        grifo_id: grifoId,
        cantidad: CANTIDAD,
        costo_unitario: 16,
        recibido_en: new Date(tRecepcion).toISOString(),
      });
      expect(recepcion.status).toBe(201);
      recepcionIds.push(recepcion.body.id);

      nivel = nivel + CANTIDAD + diferenciasLitros[i];
      await agente.post("/api/erp/combustible/lecturas").send({
        combustible_id: tanqueId,
        nivel,
        leido_en: new Date(tDespues).toISOString(),
      });
    }

    return recepcionIds;
  }

  it("con menos de 10 recepciones atribuibles, dice que la muestra es insuficiente", async () => {
    const { tanqueId, grifoId } = await crearTanqueYGrifo();
    await construirMuestra(tanqueId, grifoId, [0, -10, 10]);

    const res = await agente.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(res.status).toBe(200);
    expect(res.body.diferencia.muestraSuficiente).toBe(false);
    expect(res.body.diferencia.tamanioMuestra).toBe(3);
    expect(res.body.diferencia.minimoRequerido).toBe(10);
    expect(res.body.diferencia.sugerido).toBeUndefined();
  });

  it("con muestra suficiente, sugiere promedio + 2 desvíos de |diferencia_pct|, con piso 1%", async () => {
    const { tanqueId, grifoId } = await crearTanqueYGrifo();
    // cantidad fija en 1000 -> diferencia_litros/10 = diferencia_pct.
    const diferenciasLitros = [-20, -10, 0, 10, 20, -20, -10, 0, 10, 20];
    await construirMuestra(tanqueId, grifoId, diferenciasLitros);

    const res = await agente.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(res.status).toBe(200);
    expect(res.body.diferencia.muestraSuficiente).toBe(true);
    expect(res.body.diferencia.tamanioMuestra).toBe(10);

    // cantidad = 1000 -> diferencia_pct = (l / 1000) * 100 = l / 10.
    const pctAbs = diferenciasLitros.map((l) => Math.abs(l) / 10);
    const promedioEsperado = pctAbs.reduce((a, b) => a + b, 0) / pctAbs.length;
    const varianzaEsperada =
      pctAbs.reduce((acc, v) => acc + (v - promedioEsperado) ** 2, 0) / (pctAbs.length - 1);
    const desviacionEsperada = Math.sqrt(varianzaEsperada);
    const sugeridoEsperado = Math.max(1, promedioEsperado + 2 * desviacionEsperada);

    expect(res.body.diferencia.promedio).toBeCloseTo(promedioEsperado, 1);
    expect(res.body.diferencia.desviacion).toBeCloseTo(desviacionEsperada, 1);
    expect(res.body.diferencia.sugerido).toBeCloseTo(sugeridoEsperado, 1);
    expect(res.body.diferencia.muestra).toHaveLength(10);
  });

  it("nunca sugiere por debajo del piso de 1%, aunque la muestra sea perfecta", async () => {
    const { tanqueId, grifoId } = await crearTanqueYGrifo();
    // Diez recepciones SIN diferencia -- promedio y desvío dan 0.
    await construirMuestra(tanqueId, grifoId, new Array(10).fill(0));

    const res = await agente.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(res.body.diferencia.muestraSuficiente).toBe(true);
    expect(res.body.diferencia.promedio).toBe(0);
    expect(res.body.diferencia.sugerido).toBe(1);
  });

  it("una recepción anulada no cuenta para la muestra", async () => {
    const { tanqueId, grifoId } = await crearTanqueYGrifo();
    const ids = await construirMuestra(tanqueId, grifoId, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    const antes = await agente.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(antes.body.diferencia.tamanioMuestra).toBe(10);

    await agente
      .patch(`/api/erp/combustible/recepciones/${ids[0]}/anular`)
      .send({ motivo: "recepción de prueba, anulada a propósito" });

    const despues = await agente.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(despues.body.diferencia.tamanioMuestra).toBe(9);
  });

  it("un tanque inexistente da 404", async () => {
    const res = await agente.get("/api/erp/combustible/999999999/sugerencia-umbral");
    expect(res.status).toBe(404);
  });

  it("un operador no puede pedir la sugerencia (visibilidad de gerencia)", async () => {
    const { tanqueId } = await crearTanqueYGrifo();
    const emailOperador = idUnico("operador-umbral") + "@test.local";
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Operador", email: emailOperador, password, rol: "operador" },
        client
      )
    );
    const agenteOperador = request.agent(app);
    await agenteOperador
      .post("/api/auth/login")
      .send({ tenantSlug, email: emailOperador, password });

    const res = await agenteOperador.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
    expect(res.status).toBe(403);
  });

  it("un tenant no puede pedir la sugerencia del tanque de otro (RLS)", async () => {
    const { tanqueId } = await crearTanqueYGrifo();

    const otro = await crearTenantDePrueba(password);
    const agenteOtro = request.agent(app);
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    try {
      const res = await agenteOtro.get(`/api/erp/combustible/${tanqueId}/sugerencia-umbral`);
      expect(res.status).toBe(404);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });
});
