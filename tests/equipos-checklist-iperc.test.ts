import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { crearUsuarioService } from "../src/server/services/auth.service";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("equipos + checklist de pre-uso + IPERC continuo", () => {
  let tenantId: string;
  let tenantSlug: string;
  let equipoId: number;
  let plantillaId: number;
  let ipercId: number;
  const password = "ClaveDePrueba123";

  const agentAdmin = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agentAdmin
      .post("/api/auth/login")
      .send({ tenantSlug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("crea un equipo", async () => {
    const res = await agentAdmin.post("/api/erp/equipos").send({
      placa_codigo: "V1A-123",
      tipo: "Camioneta",
      marca: "Toyota",
      modelo: "Hilux",
    });
    expect(res.status).toBe(201);
    equipoId = res.body.id;
  });

  it("crea una plantilla de checklist con ítems", async () => {
    const res = await agentAdmin.post("/api/erp/checklists/plantillas").send({
      nombre: "Pre-uso camioneta",
      tipo_equipo: "Camioneta",
      items: [
        { descripcion: "Frenos" },
        { descripcion: "Luces" },
        { descripcion: "Niveles de aceite" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(3);
    plantillaId = res.body.id;
  });

  it("llena un checklist para el equipo, calcula 'resultado' solo si algo quedó mal", async () => {
    const res = await agentAdmin.post("/api/erp/checklists").send({
      equipo_id: equipoId,
      plantilla_id: plantillaId,
      turno: "día",
      items: [
        { descripcion: "Frenos", estado: "bien" },
        { descripcion: "Luces", estado: "malo", observacion: "Luz trasera derecha quemada" },
        { descripcion: "Niveles de aceite", estado: "bien" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.resultado).toBe("observado");

    const detalle = await agentAdmin.get(`/api/erp/checklists/${res.body.id}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body.items).toHaveLength(3);
  });

  it("crea un IPERC en borrador y calcula nivel_riesgo en la BD", async () => {
    const res = await agentAdmin.post("/api/erp/iperc").send({
      area_frente: "Frente Norte",
      turno: "día",
      equipo_id: equipoId,
      items: [
        {
          etapa_actividad: "Traslado a frente",
          peligro: "Terreno irregular",
          riesgo: "Caída a desnivel",
          probabilidad: 3,
          severidad: 2,
          medidas_control: "Uso de EPP, inspección previa del terreno",
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.estado).toBe("borrador");
    ipercId = res.body.id;

    const detalle = await agentAdmin.get(`/api/erp/iperc/${ipercId}`);
    expect(detalle.body.items[0].nivel_riesgo).toBe(6); // 3 * 2, calculado por Postgres
  });

  it("un operador puede crear IPERC pero no aprobarlo (403); admin sí puede", async () => {
    const emailOperador = `operador-iperc-${Date.now()}@test.local`;
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Operador", email: emailOperador, password, rol: "operador" },
        client
      )
    );

    const agentOperador = request.agent(app);
    await agentOperador
      .post("/api/auth/login")
      .send({ tenantSlug, email: emailOperador, password });

    const intentoOperador = await agentOperador
      .patch(`/api/erp/iperc/${ipercId}/estado`)
      .send({ estado: "aprobado" });
    expect(intentoOperador.status).toBe(403);

    const aprobacionAdmin = await agentAdmin
      .patch(`/api/erp/iperc/${ipercId}/estado`)
      .send({ estado: "aprobado" });
    expect(aprobacionAdmin.status).toBe(200);
    expect(aprobacionAdmin.body.estado).toBe("aprobado");
  });
});

describe("aislamiento entre tenants: equipos e IPERC", () => {
  let tenantAId: string;
  let tenantBId: string;
  const password = "ClaveDePrueba123";

  afterAll(async () => {
    await borrarTenantDePrueba(tenantAId);
    await borrarTenantDePrueba(tenantBId);
  });

  it("un tenant no ve los equipos ni los IPERC de otro", async () => {
    const a = await crearTenantDePrueba(password);
    const b = await crearTenantDePrueba(password);
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;

    const agentA = request.agent(app);
    const agentB = request.agent(app);
    await agentA
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, email: a.usuario.email, password });
    await agentB
      .post("/api/auth/login")
      .send({ tenantSlug: b.tenant.slug, email: b.usuario.email, password });

    await agentA.post("/api/erp/equipos").send({ placa_codigo: "AAA-111", tipo: "Camioneta" });
    await agentB.post("/api/erp/equipos").send({ placa_codigo: "AAA-111", tipo: "Camioneta" });

    const listaA = await agentA.get("/api/erp/equipos");
    const listaB = await agentB.get("/api/erp/equipos");
    expect(listaA.body.data).toHaveLength(1);
    expect(listaB.body.data).toHaveLength(1);
  });
});

// Un solo cierre de pool para todo el archivo — closeDatabase() dentro de
// un afterAll de un describe individual rompía el segundo describe (el
// pool ya estaba cerrado cuando le tocaba correr, "Cannot use a pool
// after calling end on the pool").
afterAll(async () => {
  await closeDatabase();
});
