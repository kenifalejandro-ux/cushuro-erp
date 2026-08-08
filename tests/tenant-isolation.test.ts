import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("aislamiento entre tenants (RLS + filtrado explícito)", () => {
  let tenantAId: string;
  let tenantBId: string;
  let emailA: string;
  let emailB: string;
  let repuestoIdA: number;
  const password = "ClaveDePrueba123";

  const agentA = request.agent(app);
  const agentB = request.agent(app);

  beforeAll(async () => {
    const a = await crearTenantDePrueba(password);
    const b = await crearTenantDePrueba(password);
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;
    emailA = a.usuario.email;
    emailB = b.usuario.email;

    await agentA
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, email: emailA, password });
    await agentB
      .post("/api/auth/login")
      .send({ tenantSlug: b.tenant.slug, email: emailB, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantAId);
    await borrarTenantDePrueba(tenantBId);
    await closeDatabase();
  });

  it("dos tenants pueden usar el mismo código sin chocar, y cada uno ve solo lo suyo", async () => {
    const creadoA = await agentA.post("/api/erp/repuestos").send({
      codigo: "FIL-001",
      nombre: "Filtro A",
      categoria: "Motor",
      stock: 10,
      stock_minimo: 2,
      stock_maximo: 50,
      precio: 25.5,
    });
    expect(creadoA.status).toBe(201);
    repuestoIdA = creadoA.body.id;

    const creadoB = await agentB.post("/api/erp/repuestos").send({
      codigo: "FIL-001",
      nombre: "Filtro B",
      categoria: "Motor",
      stock: 5,
      stock_minimo: 1,
      stock_maximo: 20,
      precio: 10,
    });
    expect(creadoB.status).toBe(201);

    const listaA = await agentA.get("/api/erp/repuestos");
    expect(listaA.body.data).toHaveLength(1);
    expect(listaA.body.data[0].nombre).toBe("Filtro A");

    const listaB = await agentB.get("/api/erp/repuestos");
    expect(listaB.body.data).toHaveLength(1);
    expect(listaB.body.data[0].nombre).toBe("Filtro B");
  });

  it("un tenant no puede editar ni borrar un repuesto de otro tenant (404, no un error genérico)", async () => {
    const update = await agentB.put(`/api/erp/repuestos/${repuestoIdA}`).send({
      codigo: "HACK",
      nombre: "Hackeado",
      categoria: "Motor",
      stock: 0,
      stock_minimo: 0,
      stock_maximo: 0,
      precio: 0,
    });
    expect(update.status).toBe(404);

    const del = await agentB.delete(`/api/erp/repuestos/${repuestoIdA}`);
    expect(del.status).toBe(404);

    // La fila de A sigue intacta.
    const listaA = await agentA.get("/api/erp/repuestos");
    expect(listaA.body.data).toHaveLength(1);
    expect(listaA.body.data[0].nombre).toBe("Filtro A");
  });

  it("el dashboard de cada tenant es independiente", async () => {
    const dashA = await agentA.get("/api/erp/dashboard");
    expect(dashA.status).toBe(200);
    expect(Number(dashA.body.total_repuestos)).toBe(1);

    const dashB = await agentB.get("/api/erp/dashboard");
    expect(dashB.status).toBe(200);
    expect(Number(dashB.body.total_repuestos)).toBe(1);
  });
});
