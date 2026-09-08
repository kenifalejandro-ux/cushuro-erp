/** tests/combustible-fechas-y-baja.test.ts
 *
 * Tres robos de la simulación adversaria contra el módulo YA endurecido,
 * convertidos en regresión. Los tres pasaron sin disparar una sola alerta,
 * con los tres umbrales configurados.
 *
 * 1. VARILLA FUTURA. `leido_en` no validaba nada. Se aceptó una lectura
 *    fechada 90 días adelante -- y como el nivel del tanque ES la última
 *    lectura vigente, esa medición inventada se volvía el nivel oficial y
 *    ninguna lectura real la desplazaba hasta llegar esa fecha. El despacho
 *    ya lo validaba desde 0077; la lectura no.
 *
 * 2. VARILLA HACIA ATRÁS. Insertada dentro del ciclo vivo, mueve el punto de
 *    partida del balance: con un nivel inventado más bajo al inicio, un
 *    faltante real se lee como sobrante.
 *
 * 3. TANQUE DADO DE BAJA. No pedía motivo -- menos que subir un umbral, que
 *    es al revés de lo que corresponde -- y encima seguía aceptando
 *    despachos con la vigilancia de "sin medir" apagada.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

let seq = 0;
const serieUnica = () => `S${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;

describe("combustible: fechas de lectura y baja de tanque (migración 0078)", () => {
  let tenantId: string;
  let equipoId: number;
  let grifoId: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });

    const eq = await ag
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EX"), tipo: "Excavadora" });
    equipoId = eq.body.id;

    const g = await ag
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("Prov"), abastece_tanque: true });
    grifoId = g.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(nivelInicial = 20000) {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque vigilado",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: nivelInicial,
      nivel_minimo: 2000,
      modo_vigilancia: "personalizado",
      umbral_descuadre_pct: 1,
      umbral_descuadre_ciclo_pct: 2,
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  const leer = (tq: number, nivel: number, cuando?: string) =>
    ag
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tq, nivel, ...(cuando ? { leido_en: cuando } : {}) });

  const alertasDe = async (tq: number, tipo: string) => {
    const r = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 300 });
    return r.body.data.filter(
      (a: { tipo: string; combustible_id: number }) => a.tipo === tipo && a.combustible_id === tq
    );
  };

  const haceHoras = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  // ── 1. Fecha futura ───────────────────────────────────────────────────

  it("rechaza una lectura fechada en el futuro", async () => {
    const tq = await tanque();
    const dentroDe90Dias = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
    const res = await leer(tq, 19000, dentroDe90Dias);
    expect(res.status).toBe(400);
  });

  it("el nivel del tanque no se puede congelar con una fecha futura", async () => {
    // El daño concreto que evitaba: el nivel ES la última lectura vigente.
    // Sin `leido_en`: la lectura toma NOW() y queda por delante de la
    // `inicial` del alta, que también se crea con NOW().
    const tq = await tanque();
    await leer(tq, 15000);

    const futuro = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    await leer(tq, 999, futuro);

    const ficha = await ag.get(`/api/erp/combustible/${tq}`);
    expect(Number(ficha.body.nivel_actual)).toBe(15000);
  });

  it("una lectura de hace un rato entra sin problema", async () => {
    // El margen de 1 hora existe para los relojes corridos de cancha; el
    // pasado nunca se cuestiona por sí solo.
    const tq = await tanque();
    const res = await leer(tq, 18000, haceHoras(3));
    expect(res.status).toBe(201);
  });

  // ── 2. Lectura hacia atrás ────────────────────────────────────────────

  it("una varilla insertada hacia atrás en el ciclo vivo alerta, sin bloquear", async () => {
    const tq = await tanque();
    await leer(tq, 20000, haceHoras(10));
    await leer(tq, 19000, haceHoras(4));

    // Llega una medición fechada ENTRE las dos.
    const retro = await leer(tq, 19500, haceHoras(7));
    // No bloquea: el caso legítimo es la cola offline, y perder mediciones
    // reales de cancha sería peor que la manipulación que evita.
    expect(retro.status).toBe(201);

    const al = await alertasDe(tq, "lectura_retroactiva");
    expect(al).toHaveLength(1);
    expect(Number(al[0].detalle.posteriores)).toBe(1);
  });

  it("la lectura más reciente NO alerta: es el caso normal", async () => {
    const tq = await tanque();
    await leer(tq, 20000, haceHoras(10));
    await leer(tq, 19000, haceHoras(4));

    expect(await alertasDe(tq, "lectura_retroactiva")).toHaveLength(0);
  });

  it("una lectura hacia atrás en un ciclo YA CERRADO no alerta", async () => {
    // Sería ruido: no puede cambiar ningún cálculo futuro, porque el tramo
    // mira la lectura inmediata anterior y el ciclo arranca en la última
    // recepción. Un control ruidoso se ignora.
    const tq = await tanque(0);
    await leer(tq, 0, haceHoras(50));
    await leer(tq, 1000, haceHoras(48));

    // Una recepción cierra el ciclo viejo y abre uno nuevo.
    const rec = await ag.post("/api/erp/combustible/recepciones").send({
      combustible_id: tq,
      grifo_id: grifoId,
      cantidad: 5000,
      costo_unitario: 16,
      tipo_documento: "factura",
      numero_documento: idUnico("F"),
      recibido_en: haceHoras(24),
    });
    expect(rec.status).toBe(201);
    await leer(tq, 6000, haceHoras(20));

    // Ahora, una lectura fechada en el ciclo viejo (antes de la recepción).
    const retro = await leer(tq, 900, haceHoras(47));
    expect(retro.status).toBe(201);
    expect(await alertasDe(tq, "lectura_retroactiva")).toHaveLength(0);
  });

  // ── 3. Baja del tanque ────────────────────────────────────────────────

  it("dar de baja un tanque SIN motivo se rechaza", async () => {
    const tq = await tanque();
    const res = await ag.delete(`/api/erp/combustible/${tq}`).send({});
    expect(res.status).toBe(400);
  });

  it("la baja se audita como vigilancia reducida, no como una edición más", async () => {
    const tq = await tanque();
    const res = await ag
      .delete(`/api/erp/combustible/${tq}`)
      .send({ motivo: "Tanque retirado de la sede" });
    expect(res.status).toBe(200);

    const log = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT detalle FROM platform_audit_log
         WHERE tenant_id = $1 AND accion = 'combustible.tanque_vigilancia_reducida'
         ORDER BY id DESC LIMIT 1`,
        [tenantId]
      )
    );
    expect(log.rows[0].detalle.motivo).toContain("retirado");
    expect(log.rows[0].detalle.aflojados[0].control).toContain("baja");
  });

  it("un tanque desactivado NO puede seguir despachando", async () => {
    // Lo que la simulación logró: dar de baja el tanque -- que además lo saca
    // del aviso por falta de medición -- y seguir sacándole 5.000 L.
    const tq = await tanque();
    await ag.delete(`/api/erp/combustible/${tq}`).send({ motivo: "Fuera de servicio" });

    const res = await ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad: 5000,
      lectura_contometro: 5000,
      costo_unitario: 16,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("desactivado");
  });

  it("un tanque activo despacha normalmente", async () => {
    const tq = await tanque();
    const res = await ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad: 500,
      lectura_contometro: 500,
      costo_unitario: 16,
    });
    expect(res.status).toBe(201);
  });
});
