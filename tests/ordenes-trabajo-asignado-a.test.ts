/** tests/ordenes-trabajo-asignado-a.test.ts
 *
 * Dueño de una OT (ver migrations/0051): sin esto, la cola de abiertas no
 * tenía dueño. `creado_por` (quién la abrió) y `asignado_a` (a quién le
 * toca ejecutarla) son roles distintos a propósito.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";

describe("Órdenes de Trabajo: asignado_a", () => {
  let tenantId: string;
  let tenantSlug: string;
  const password = "ClaveDePrueba123";
  const agenteAdmin = request.agent(app);
  let equipoId: number;
  let usuarioActivoId: string;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agenteAdmin
      .post("/api/auth/login")
      .send({ tenantSlug, email: creado.usuario.email, password });

    const equipo = await agenteAdmin
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("ASIG-EQ"), tipo: "Camioneta" });
    equipoId = equipo.body.id;

    const emailActivo = `${idUnico("tecnico")}@test.local`;
    const alta = await request(app)
      .post(`/api/platform/tenants/${tenantId}/usuarios`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({ nombre: "Técnico Activo", email: emailActivo, password, rol: "operador" });
    usuarioActivoId = alta.body.usuario.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("crea una OT con asignado_a válido (usuario activo del tenant)", async () => {
    const res = await agenteAdmin.post("/api/erp/ordenes_trabajo").send({
      equipo_id: equipoId,
      titulo: "Revisión de frenos",
      asignado_a: usuarioActivoId,
    });
    expect(res.status).toBe(201);
    expect(res.body.asignado_a).toBe(usuarioActivoId);
  });

  it("edita (PUT) para asignar/reasignar una OT existente", async () => {
    const creada = await agenteAdmin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, titulo: "Sin asignar todavía" });
    expect(creada.body.asignado_a).toBeNull();

    const editada = await agenteAdmin.put(`/api/erp/ordenes_trabajo/${creada.body.id}`).send({
      titulo: "Sin asignar todavía",
      tipo: "correctivo",
      prioridad: "media",
      asignado_a: usuarioActivoId,
    });
    expect(editada.status).toBe(200);
    expect(editada.body.asignado_a).toBe(usuarioActivoId);

    // Omitir el campo en un PUT posterior desasigna -- mismo criterio que
    // iperc_id (el PUT reemplaza la fila entera).
    const desasignada = await agenteAdmin.put(`/api/erp/ordenes_trabajo/${creada.body.id}`).send({
      titulo: "Sin asignar todavía",
      tipo: "correctivo",
      prioridad: "media",
    });
    expect(desasignada.status).toBe(200);
    expect(desasignada.body.asignado_a).toBeNull();
  });

  it("asignado_a inexistente en el tenant → 400", async () => {
    const res = await agenteAdmin.post("/api/erp/ordenes_trabajo").send({
      equipo_id: equipoId,
      titulo: "OT con usuario inexistente",
      asignado_a: "11111111-1111-4111-8111-111111111111",
    });
    expect(res.status).toBe(400);
  });

  it("asignado_a de OTRO tenant → 400", async () => {
    const otroTenant = await crearTenantDePrueba(password);
    try {
      const res = await agenteAdmin.post("/api/erp/ordenes_trabajo").send({
        equipo_id: equipoId,
        titulo: "OT con usuario de otro tenant",
        asignado_a: otroTenant.usuario.id,
      });
      expect(res.status).toBe(400);
    } finally {
      await borrarTenantDePrueba(otroTenant.tenant.id);
    }
  });

  it("asignado_a INACTIVO → 400", async () => {
    const emailInactivo = `${idUnico("inactivo")}@test.local`;
    const alta = await request(app)
      .post(`/api/platform/tenants/${tenantId}/usuarios`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({ nombre: "Usuario Inactivo", email: emailInactivo, password, rol: "operador" });
    const usuarioInactivoId = alta.body.usuario.id;

    await request(app)
      .patch(`/api/platform/tenants/${tenantId}/usuarios/${usuarioInactivoId}/estado`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({ activo: false });

    const res = await agenteAdmin.post("/api/erp/ordenes_trabajo").send({
      equipo_id: equipoId,
      titulo: "OT con usuario inactivo",
      asignado_a: usuarioInactivoId,
    });
    expect(res.status).toBe(400);
  });

  it("listado de asignables: solo activos del tenant, sin rol lectura, sin inactivos", async () => {
    const emailLectura = `${idUnico("lectura")}@test.local`;
    await request(app)
      .post(`/api/platform/tenants/${tenantId}/usuarios`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({ nombre: "Usuario Lectura", email: emailLectura, password, rol: "lectura" });

    const res = await agenteAdmin.get("/api/erp/ordenes_trabajo/usuarios-asignables");
    expect(res.status).toBe(200);
    const nombres = (res.body as { nombre: string }[]).map((u) => u.nombre);
    expect(nombres).toContain("Técnico Activo");
    expect(nombres).not.toContain("Usuario Lectura");
    expect(nombres).not.toContain("Usuario Inactivo");
  });

  it("operador puede asignar al crear; lectura no puede ni crear una OT (403 de rol, no de asignado_a)", async () => {
    const emailOperador = `${idUnico("op-asig")}@test.local`;
    await request(app)
      .post(`/api/platform/tenants/${tenantId}/usuarios`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({ nombre: "Operador Asignador", email: emailOperador, password, rol: "operador" });

    const agenteOperador = request.agent(app);
    await agenteOperador
      .post("/api/auth/login")
      .send({ tenantSlug, email: emailOperador, password });

    const creada = await agenteOperador.post("/api/erp/ordenes_trabajo").send({
      equipo_id: equipoId,
      titulo: "Creada y asignada por operador",
      asignado_a: usuarioActivoId,
    });
    expect(creada.status).toBe(201);
    expect(creada.body.asignado_a).toBe(usuarioActivoId);

    const emailLectura2 = `${idUnico("lectura2")}@test.local`;
    await request(app)
      .post(`/api/platform/tenants/${tenantId}/usuarios`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({ nombre: "Otro Lectura", email: emailLectura2, password, rol: "lectura" });
    const agenteLectura = request.agent(app);
    await agenteLectura
      .post("/api/auth/login")
      .send({ tenantSlug, email: emailLectura2, password });

    const rechazada = await agenteLectura
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, titulo: "No debería poder crear esto" });
    expect(rechazada.status).toBe(403);
  });
});
