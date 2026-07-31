import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { crearUsuarioService } from "../src/server/services/auth.service";
import { closeDatabase } from "../src/server/config/database";

describe("permisos por rol (requireRole en rutas de negocio)", () => {
  let tenantId: string;
  let repuestoId: number;
  const password = "ClaveDePrueba123";

  const agentAdmin = request.agent(app);
  const agentOperador = request.agent(app);
  const agentLectura = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;

    const emailOperador = `${idUnico("operador")}@test.local`;
    const emailLectura = `${idUnico("lectura")}@test.local`;

    await crearUsuarioService({
      tenantId,
      nombre: "Usuario Operador",
      email: emailOperador,
      password,
      rol: "operador",
    });
    await crearUsuarioService({
      tenantId,
      nombre: "Usuario Lectura",
      email: emailLectura,
      password,
      rol: "lectura",
    });

    await agentAdmin.post("/api/auth/login").send({ email: creado.usuario.email, password });
    await agentOperador.post("/api/auth/login").send({ email: emailOperador, password });
    await agentLectura.post("/api/auth/login").send({ email: emailLectura, password });

    const creadoRepuesto = await agentAdmin.post("/api/erp/repuestos").send({
      codigo: "ROL-001",
      nombre: "Repuesto de prueba",
      categoria: "Motor",
      stock: 1,
      stock_minimo: 1,
      stock_maximo: 10,
      precio: 1,
    });
    repuestoId = creadoRepuesto.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("lectura puede ver pero no crear, editar ni borrar (403)", async () => {
    const get = await agentLectura.get("/api/erp/repuestos");
    expect(get.status).toBe(200);

    const post = await agentLectura.post("/api/erp/repuestos").send({
      codigo: "ROL-002",
      nombre: "No debería crearse",
      categoria: "Motor",
      stock: 1,
      stock_minimo: 1,
      stock_maximo: 10,
      precio: 1,
    });
    expect(post.status).toBe(403);

    const put = await agentLectura.put(`/api/erp/repuestos/${repuestoId}`).send({
      codigo: "ROL-001",
      nombre: "No debería editarse",
      categoria: "Motor",
      stock: 1,
      stock_minimo: 1,
      stock_maximo: 10,
      precio: 1,
    });
    expect(put.status).toBe(403);

    const del = await agentLectura.delete(`/api/erp/repuestos/${repuestoId}`);
    expect(del.status).toBe(403);
  });

  it("operador puede crear y editar pero no borrar (403)", async () => {
    const post = await agentOperador.post("/api/erp/repuestos").send({
      codigo: "ROL-003",
      nombre: "Creado por operador",
      categoria: "Motor",
      stock: 1,
      stock_minimo: 1,
      stock_maximo: 10,
      precio: 1,
    });
    expect(post.status).toBe(201);

    const put = await agentOperador.put(`/api/erp/repuestos/${repuestoId}`).send({
      codigo: "ROL-001",
      nombre: "Editado por operador",
      categoria: "Motor",
      stock: 2,
      stock_minimo: 1,
      stock_maximo: 10,
      precio: 1,
    });
    expect(put.status).toBe(200);

    const del = await agentOperador.delete(`/api/erp/repuestos/${repuestoId}`);
    expect(del.status).toBe(403);
  });

  it("admin puede borrar", async () => {
    const del = await agentAdmin.delete(`/api/erp/repuestos/${repuestoId}`);
    expect(del.status).toBe(200);
  });
});
