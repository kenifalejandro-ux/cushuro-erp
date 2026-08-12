/** tests/documentos.test.ts
 *
 * `PUT /:id` y `POST /bulk` siguen sin schema de validación (req.body pasa
 * directo a la query) -- solo `POST /` valida con Zod (ver
 * documentos.schema.ts, sumado junto con offline). Estos tests cubren la
 * regla de negocio real (estado_alerta calculado por fecha_vencimiento),
 * CRUD, bulk, permisos por rol, y el aviso de posible duplicado.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { crearUsuarioService } from "../src/server/services/auth.service";
import { closeDatabase, withTenant } from "../src/server/config/database";

function fechaEn(dias: number): string {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

describe("documentos: CRUD, estado_alerta y permisos por rol", () => {
  let tenantId: string;
  let tenantSlug: string;
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

  it("crea un documento con los campos mínimos", async () => {
    const res = await agentAdmin.post("/api/erp/documentos").send({
      nombre_documento: "Licencia de conducir",
      responsable: "Juan Pérez",
      fecha_vencimiento: fechaEn(30),
    });
    expect(res.status).toBe(201);
    expect(res.body.nombre_documento).toBe("Licencia de conducir");
  });

  it("estado_alerta se calcula en Postgres según fecha_vencimiento: VENCIDO / POR VENCER / VIGENTE", async () => {
    await agentAdmin.post("/api/erp/documentos").send({
      nombre_documento: "Vencido hace una semana",
      responsable: "A",
      fecha_vencimiento: fechaEn(-7),
    });
    await agentAdmin.post("/api/erp/documentos").send({
      nombre_documento: "Vence en 5 días",
      responsable: "B",
      fecha_vencimiento: fechaEn(5),
    });
    await agentAdmin.post("/api/erp/documentos").send({
      nombre_documento: "Vence en 90 días",
      responsable: "C",
      fecha_vencimiento: fechaEn(90),
    });

    const res = await agentAdmin.get("/api/erp/documentos?pageSize=100");
    expect(res.status).toBe(200);
    const porNombre = (nombre: string) =>
      res.body.data.find((d: { nombre_documento: string }) => d.nombre_documento === nombre);

    expect(porNombre("Vencido hace una semana").estado_alerta).toBe("VENCIDO");
    expect(porNombre("Vence en 5 días").estado_alerta).toBe("POR VENCER");
    expect(porNombre("Vence en 90 días").estado_alerta).toBe("VIGENTE");
  });

  it("actualiza un documento existente", async () => {
    const creado = await agentAdmin.post("/api/erp/documentos").send({
      nombre_documento: "Para actualizar",
      responsable: "Original",
      fecha_vencimiento: fechaEn(60),
    });

    const res = await agentAdmin.put(`/api/erp/documentos/${creado.body.id}`).send({
      nombre_documento: "Ya actualizado",
      responsable: "Nuevo responsable",
      fecha_vencimiento: fechaEn(60),
      estado: "vigente",
    });
    expect(res.status).toBe(200);
    expect(res.body.nombre_documento).toBe("Ya actualizado");
    expect(res.body.responsable).toBe("Nuevo responsable");
  });

  it("actualizar un documento inexistente da 404", async () => {
    const res = await agentAdmin.put("/api/erp/documentos/999999999").send({
      nombre_documento: "No existe",
      responsable: "X",
      fecha_vencimiento: fechaEn(1),
    });
    expect(res.status).toBe(404);
  });

  it("elimina un documento", async () => {
    const creado = await agentAdmin.post("/api/erp/documentos").send({
      nombre_documento: "Para borrar",
      responsable: "X",
      fecha_vencimiento: fechaEn(10),
    });

    const borrado = await agentAdmin.delete(`/api/erp/documentos/${creado.body.id}`);
    expect(borrado.status).toBe(200);

    const segundoBorrado = await agentAdmin.delete(`/api/erp/documentos/${creado.body.id}`);
    expect(segundoBorrado.status).toBe(404);
  });

  it("carga masiva (bulk) inserta varios documentos de una vez", async () => {
    const antes = await agentAdmin.get("/api/erp/documentos?pageSize=1");
    const totalAntes = antes.body.pagination.total;

    const res = await agentAdmin.post("/api/erp/documentos/bulk").send([
      { nombre_documento: "Bulk 1", responsable: "A", fecha_vencimiento: fechaEn(15) },
      { nombre_documento: "Bulk 2", responsable: "B", fecha_vencimiento: fechaEn(20) },
    ]);
    expect(res.status).toBe(201);

    const despues = await agentAdmin.get("/api/erp/documentos?pageSize=1");
    expect(despues.body.pagination.total).toBe(totalAntes + 2);
  });

  it("un usuario con rol 'lectura' no puede crear ni borrar (403), pero sí puede leer", async () => {
    const email = `lectura-documentos-${Date.now()}@test.local`;
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Solo lectura", email, password, rol: "lectura" },
        client
      )
    );

    const agentLectura = request.agent(app);
    await agentLectura.post("/api/auth/login").send({ tenantSlug, email, password });

    const lectura = await agentLectura.get("/api/erp/documentos");
    expect(lectura.status).toBe(200);

    const intentoCrear = await agentLectura.post("/api/erp/documentos").send({
      nombre_documento: "No debería crearse",
      responsable: "X",
      fecha_vencimiento: fechaEn(1),
    });
    expect(intentoCrear.status).toBe(403);
  });

  it("un 'operador' puede crear pero no puede borrar (solo admin borra)", async () => {
    const email = `operador-documentos-${Date.now()}@test.local`;
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Operador", email, password, rol: "operador" },
        client
      )
    );

    const agentOperador = request.agent(app);
    await agentOperador.post("/api/auth/login").send({ tenantSlug, email, password });

    const creado = await agentOperador.post("/api/erp/documentos").send({
      nombre_documento: "Creado por operador",
      responsable: "X",
      fecha_vencimiento: fechaEn(1),
    });
    expect(creado.status).toBe(201);

    const intentoBorrar = await agentOperador.delete(`/api/erp/documentos/${creado.body.id}`);
    expect(intentoBorrar.status).toBe(403);
  });
});

describe("documentos: aviso de posible duplicado", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agentAdmin = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agentAdmin
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("avisa cuando ya existe un documento con el mismo nombre Y la misma fecha", async () => {
    const fecha = fechaEn(45);
    await agentAdmin.post("/api/erp/documentos").send({
      nombre_documento: "SOAT camión 12",
      responsable: "Carlos",
      fecha_vencimiento: fecha,
    });

    const chequeo = await agentAdmin.get(
      `/api/erp/documentos/duplicado?nombre=${encodeURIComponent("SOAT camión 12")}&fecha=${fecha}`
    );
    expect(chequeo.status).toBe(200);
    expect(chequeo.body.duplicado).toBe(true);
    expect(chequeo.body.documento.nombre_documento).toBe("SOAT camión 12");
  });

  it("NO avisa en una renovación normal: mismo nombre, fecha DISTINTA", async () => {
    await agentAdmin.post("/api/erp/documentos").send({
      nombre_documento: "SOAT camión 15",
      responsable: "Carlos",
      fecha_vencimiento: fechaEn(-10), // vencido, típico antes de renovar
    });

    const chequeo = await agentAdmin.get(
      `/api/erp/documentos/duplicado?nombre=${encodeURIComponent("SOAT camión 15")}&fecha=${fechaEn(365)}`
    );
    expect(chequeo.status).toBe(200);
    expect(chequeo.body.duplicado).toBe(false);
  });

  it("el match de nombre ignora mayúsculas y espacios extra", async () => {
    const fecha = fechaEn(50);
    await agentAdmin.post("/api/erp/documentos").send({
      nombre_documento: "Licencia Minera",
      responsable: "Carlos",
      fecha_vencimiento: fecha,
    });

    const chequeo = await agentAdmin.get(
      `/api/erp/documentos/duplicado?nombre=${encodeURIComponent("  licencia minera  ")}&fecha=${fecha}`
    );
    expect(chequeo.body.duplicado).toBe(true);
  });

  it("sin nombre o sin fecha responde duplicado:false en vez de error", async () => {
    const res = await agentAdmin.get("/api/erp/documentos/duplicado?nombre=algo");
    expect(res.status).toBe(200);
    expect(res.body.duplicado).toBe(false);
  });

  it("no confunde documentos de otro tenant", async () => {
    const otro = await crearTenantDePrueba(password);
    const agentOtro = request.agent(app);
    await agentOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    const fecha = fechaEn(70);
    await agentOtro.post("/api/erp/documentos").send({
      nombre_documento: "Documento de otro tenant",
      responsable: "X",
      fecha_vencimiento: fecha,
    });

    const chequeo = await agentAdmin.get(
      `/api/erp/documentos/duplicado?nombre=${encodeURIComponent("Documento de otro tenant")}&fecha=${fecha}`
    );
    expect(chequeo.body.duplicado).toBe(false);

    await borrarTenantDePrueba(otro.tenant.id);
  });
});

describe("documentos: aislamiento entre tenants", () => {
  let tenantAId: string;
  let tenantBId: string;
  const password = "ClaveDePrueba123";

  afterAll(async () => {
    await borrarTenantDePrueba(tenantAId);
    await borrarTenantDePrueba(tenantBId);
  });

  it("un tenant no ve ni puede modificar el documento de otro", async () => {
    const a = await crearTenantDePrueba(password);
    const b = await crearTenantDePrueba(password);
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;

    const agentB = request.agent(app);
    await agentB
      .post("/api/auth/login")
      .send({ tenantSlug: b.tenant.slug, email: b.usuario.email, password });

    const creadoPorB = await agentB.post("/api/erp/documentos").send({
      nombre_documento: "Documento secreto de B",
      responsable: "B",
      fecha_vencimiento: fechaEn(30),
    });
    const documentoIdDeB = creadoPorB.body.id;

    const agentA = request.agent(app);
    await agentA
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, email: a.usuario.email, password });

    const listadoDeA = await agentA.get("/api/erp/documentos?pageSize=200");
    expect(
      listadoDeA.body.data.find((d: { id: number }) => d.id === documentoIdDeB)
    ).toBeUndefined();

    const intentoBorrar = await agentA.delete(`/api/erp/documentos/${documentoIdDeB}`);
    expect(intentoBorrar.status).toBe(404);

    // La fila de B tiene que seguir intacta a pesar del intento.
    const filaB = await withTenant(tenantBId, (client) =>
      client.query(`SELECT nombre_documento FROM documentos WHERE id = $1`, [documentoIdDeB])
    );
    expect(filaB.rows).toHaveLength(1);
    expect(filaB.rows[0].nombre_documento).toBe("Documento secreto de B");
  });
});

// Un solo cierre de pool para todo el archivo -- ver el mismo comentario en
// equipos-checklist-iperc.test.ts / combustible.test.ts.
afterAll(async () => {
  await closeDatabase();
});
