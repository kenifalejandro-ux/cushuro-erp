import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("paginación de repuestos", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agent.post("/api/auth/login").send({ email: creado.usuario.email, password });

    const filas = Array.from({ length: 55 }, (_, i) => ({
      codigo: `PAG-${String(i + 1).padStart(3, "0")}`,
      nombre: `Repuesto paginado ${i + 1}`,
      categoria: "Motor",
      stock: i,
      stock_minimo: 5,
      stock_maximo: 100,
      precio: 10,
    }));
    const bulk = await agent.post("/api/erp/repuestos/bulk").send(filas);
    expect(bulk.status).toBe(201);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("page=1 trae 50 filas por default y el total correcto", async () => {
    const res = await agent.get("/api/erp/repuestos?page=1");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(50);
    expect(res.body.pagination).toMatchObject({ page: 1, pageSize: 50, total: 55, totalPages: 2 });
  });

  it("page=2 trae las 5 filas restantes", async () => {
    const res = await agent.get("/api/erp/repuestos?page=2");
    expect(res.body.data).toHaveLength(5);
    expect(res.body.pagination.page).toBe(2);
  });

  it("pageSize nunca supera el tope de 200, aunque se pida más", async () => {
    const res = await agent.get("/api/erp/repuestos?pageSize=99999");
    expect(res.body.pagination.pageSize).toBe(200);
    expect(res.body.data).toHaveLength(55);
  });
});
