/** tests/combustible-despachos-anulacion.test.ts
 *
 * Punto 3 de docs/architecture/control-de-combustible.md ("Talonarios: hace
 * falta una válvula de escape"), primera entrega de la Fase D.
 *
 * El caso del documento: a Juan se le vuelca diésel encima del vale 00025.
 * Sin forma de rendirlo, el sistema le grita "posible despacho no declarado"
 * cada vez, y a la cuarta Juan inventa un vale para que la secuencia cierre.
 * El control anti-fraude terminaría fabricando el fraude.
 *
 * Lo que se cubre acá, más allá del happy path:
 *  - el vale anulado cuenta como RENDIDO en el hueco de talonario, no como
 *    hueco (si no, la válvula de escape no serviría de nada);
 *  - anular LIBERA el número dentro de la serie, para poder recargar el mismo
 *    papel con el dato corregido -- sin eso, anular un vale mal tipeado
 *    borraría del sistema un despacho que sí ocurrió;
 *  - dos vigentes con el mismo número siguen dando 409;
 *  - un despacho anulado deja de contar para la conciliación (la columna
 *    "Diferencia" de las recepciones, migración 0066).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

function serieUnica(): string {
  return `S${Math.floor(Math.random() * 1e8).toString(36)}`;
}

describe("combustible: anulación de despachos (Fase D)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  let tanqueId: number;
  let equipoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const tanque = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque anulación",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
    });
    tanqueId = tanque.body.id;

    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EX"), tipo: "EXCAVADORA" });
    equipoId = equipo.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  function payloadVale(serie: string, nVale: number, overrides: Record<string, unknown> = {}) {
    return {
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale,
      cantidad: 35,
      lectura_contometro: 35,
      costo_unitario: 16.8,
      despachado_en: new Date().toISOString(),
      ...overrides,
    };
  }

  it("anula un vale con motivo y lo deja visible, no lo borra", async () => {
    const serie = serieUnica();
    const creado = await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 25));
    expect(creado.status).toBe(201);

    const anulado = await agente
      .patch(`/api/erp/combustible/despachos/${creado.body.id}/anular`)
      .send({ motivo: "se mojó con diésel, colilla guardada en el block" });

    expect(anulado.status).toBe(200);
    expect(anulado.body.anulada_en).not.toBeNull();
    expect(anulado.body.motivo_anulacion).toContain("se mojó con diésel");

    const listado = await agente
      .get("/api/erp/combustible/despachos")
      .query({ serie_talonario: serie });
    expect(listado.body.data).toHaveLength(1);
    expect(listado.body.data[0].anulada_en).not.toBeNull();
  });

  it("el motivo es obligatorio", async () => {
    const creado = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadVale(serieUnica(), 1));

    const res = await agente
      .patch(`/api/erp/combustible/despachos/${creado.body.id}/anular`)
      .send({ motivo: "   " });
    expect(res.status).toBe(400);
  });

  it("anular dos veces da 409 y no pisa el motivo original", async () => {
    const creado = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadVale(serieUnica(), 1));

    const primera = await agente
      .patch(`/api/erp/combustible/despachos/${creado.body.id}/anular`)
      .send({ motivo: "motivo original" });
    expect(primera.status).toBe(200);

    const segunda = await agente
      .patch(`/api/erp/combustible/despachos/${creado.body.id}/anular`)
      .send({ motivo: "intento de pisar" });
    expect(segunda.status).toBe(409);

    const listado = await agente.get("/api/erp/combustible/despachos");
    const fila = listado.body.data.find(
      (d: { id: number }) => String(d.id) === String(creado.body.id)
    );
    expect(fila.motivo_anulacion).toBe("motivo original");
  });

  it("un despacho inexistente da 404", async () => {
    const res = await agente
      .patch("/api/erp/combustible/despachos/999999999/anular")
      .send({ motivo: "no existe" });
    expect(res.status).toBe(404);
  });

  // ── Lo que hace que la válvula de escape sirva ────────────────────────

  it("un vale anulado cuenta como RENDIDO, no como hueco de talonario", async () => {
    const serie = serieUnica();
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 21));
    const roto = await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 22));
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 23));

    await agente
      .patch(`/api/erp/combustible/despachos/${roto.body.id}/anular`)
      .send({ motivo: "vale ilegible" });

    const huecos = await agente
      .get("/api/erp/combustible/despachos/huecos")
      .query({ serie_talonario: serie });

    // Si el 22 apareciera como hueco, la anulación no serviría de nada y
    // volveríamos al caso de Juan inventando un despacho para callar la
    // alarma. Este test fija ese comportamiento.
    expect(huecos.body.huecos).toEqual([]);
  });

  it("anular libera el número: el mismo vale se puede recargar corregido", async () => {
    const serie = serieUnica();
    // Juan tipeó 53 en vez de 35.
    const conError = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadVale(serie, 22, { cantidad: 53, lectura_contometro: 53 }));
    expect(conError.status).toBe(201);

    await agente
      .patch(`/api/erp/combustible/despachos/${conError.body.id}/anular`)
      .send({ motivo: "se tipeó 53 en vez de 35" });

    // El vale físico 22 existe y dice 35: tiene que poder registrarse.
    // Sin esto, anular borraría del sistema un despacho que SÍ ocurrió --
    // el combustible salió del tanque y nadie se enteraría.
    const corregido = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadVale(serie, 22, { cantidad: 35, lectura_contometro: 35 }));
    expect(corregido.status).toBe(201);
    expect(Number(corregido.body.cantidad)).toBe(35);

    const listado = await agente
      .get("/api/erp/combustible/despachos")
      .query({ serie_talonario: serie });
    // Quedan las dos filas: la anulada como evidencia y la vigente corregida.
    expect(listado.body.data).toHaveLength(2);
    const vigentes = listado.body.data.filter(
      (d: { anulada_en: string | null }) => d.anulada_en === null
    );
    expect(vigentes).toHaveLength(1);
    expect(Number(vigentes[0].cantidad)).toBe(35);
  });

  it("dos vales VIGENTES con el mismo número siguen dando 409", async () => {
    const serie = serieUnica();
    const primero = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadVale(serie, 30));
    expect(primero.status).toBe(201);

    // El duplicado real del punto 5 no se debilita por la unicidad parcial.
    const duplicado = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadVale(serie, 30));
    expect(duplicado.status).toBe(409);
  });

  it("un despacho anulado deja de contar para la conciliación", async () => {
    // La columna "Diferencia" de las recepciones (migración 0066) suma los
    // despachos de la ventana. Un vale anulado no sacó combustible: si se
    // siguiera sumando, inventaría un faltante que no existe.
    const tanque = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque conciliación",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
    });
    const grifo = await agente
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("CIST") });

    await agente.post("/api/erp/combustible/recepciones").send({
      combustible_id: tanque.body.id,
      grifo_id: grifo.body.id,
      cantidad: 5000,
      costo_unitario: 16,
    });

    const despacho = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadVale(serieUnica(), 1, { combustible_id: tanque.body.id }));
    expect(despacho.status).toBe(201);

    // Entró todo lo facturado y el vale de 35 gal se anuló, así que el nivel
    // real es 10.000 + 5.000 = 15.000 exactos.
    await agente
      .patch(`/api/erp/combustible/despachos/${despacho.body.id}/anular`)
      .send({ motivo: "el despacho no se llegó a hacer" });

    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanque.body.id, nivel: 15000 });

    const listado = await agente
      .get("/api/erp/combustible/recepciones")
      .query({ combustible_id: tanque.body.id });
    // Con el vale anulado sumándose daría -35: un faltante fantasma.
    expect(Number(listado.body.data[0].diferencia_litros)).toBeCloseTo(0, 2);
  });

  // ── Permisos y RLS ────────────────────────────────────────────────────

  it("un tenant no puede anular el vale de otro", async () => {
    const propio = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadVale(serieUnica(), 1));

    const otro = await crearTenantDePrueba(password);
    const agenteOtro = request.agent(app);
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    try {
      const intento = await agenteOtro
        .patch(`/api/erp/combustible/despachos/${propio.body.id}/anular`)
        .send({ motivo: "intento cruzado" });
      // 404 y no 403: para el otro tenant la fila sencillamente no existe.
      expect(intento.status).toBe(404);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });
});
