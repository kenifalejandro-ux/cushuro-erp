/** tests/ordenes-trabajo.test.ts */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { fijarCuotaTenant } from "../src/server/services/platformCuotas.service";

describe("Órdenes de Trabajo: CRUD, máquina de estados, roles, aislamiento", () => {
  let tenantId: string;
  let tenantSlug: string;
  const password = "ClaveDePrueba123";
  const agenteAdmin = request.agent(app);
  let equipoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agenteAdmin
      .post("/api/auth/login")
      .send({ tenantSlug, email: creado.usuario.email, password });

    const equipo = await agenteAdmin
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("OT-EQ"), tipo: "Camioneta" });
    equipoId = equipo.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("crea una OT con equipo_id válido, campos default aplicados", async () => {
    const res = await agenteAdmin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, titulo: "Cambio de aceite" });

    expect(res.status).toBe(201);
    expect(res.body.estado).toBe("abierta");
    expect(res.body.tipo).toBe("correctivo");
    expect(res.body.prioridad).toBe("media");
    expect(res.body.fecha_cierre).toBeNull();
  });

  it("400 si equipo_id no existe en el tenant (validación de la app, no un 500 de FK)", async () => {
    const res = await agenteAdmin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: 999999999, titulo: "OT sobre equipo inexistente" });

    expect(res.status).toBe(400);
  });

  it("Zod rechaza antes de tocar Postgres: sin equipo_id ni título", async () => {
    const sinEquipo = await agenteAdmin.post("/api/erp/ordenes_trabajo").send({ titulo: "x" });
    expect(sinEquipo.status).toBe(400);

    const sinTitulo = await agenteAdmin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId });
    expect(sinTitulo.status).toBe(400);
  });

  it("máquina de estados: abierta -> en_progreso -> completada, con fecha_cierre/observaciones", async () => {
    const creada = await agenteAdmin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, titulo: "Frenos" });
    const id = creada.body.id;

    const iniciar = await agenteAdmin
      .patch(`/api/erp/ordenes_trabajo/${id}/estado`)
      .send({ estado: "en_progreso" });
    expect(iniciar.status).toBe(200);
    expect(iniciar.body.fecha_cierre).toBeNull();

    const completar = await agenteAdmin
      .patch(`/api/erp/ordenes_trabajo/${id}/estado`)
      .send({ estado: "completada", observaciones_cierre: "Listo, frenos cambiados" });
    expect(completar.status).toBe(200);
    expect(completar.body.estado).toBe("completada");
    expect(completar.body.fecha_cierre).not.toBeNull();
    expect(completar.body.observaciones_cierre).toBe("Listo, frenos cambiados");
  });

  it("máquina de estados: abierta -> cancelada es válida", async () => {
    const creada = await agenteAdmin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, titulo: "Se cancela" });
    const id = creada.body.id;

    const cancelar = await agenteAdmin
      .patch(`/api/erp/ordenes_trabajo/${id}/estado`)
      .send({ estado: "cancelada" });
    expect(cancelar.status).toBe(200);
    expect(cancelar.body.estado).toBe("cancelada");
  });

  it("transición inválida (abierta -> completada, saltando en_progreso) da 409", async () => {
    const creada = await agenteAdmin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, titulo: "Salto inválido" });
    const id = creada.body.id;

    const res = await agenteAdmin
      .patch(`/api/erp/ordenes_trabajo/${id}/estado`)
      .send({ estado: "completada" });
    expect(res.status).toBe(409);
  });

  it("un estado terminal (completada) no admite otra transición encima", async () => {
    const creada = await agenteAdmin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, titulo: "Ya cerrada" });
    const id = creada.body.id;

    await agenteAdmin
      .patch(`/api/erp/ordenes_trabajo/${id}/estado`)
      .send({ estado: "en_progreso" });
    await agenteAdmin.patch(`/api/erp/ordenes_trabajo/${id}/estado`).send({ estado: "completada" });

    const otraVez = await agenteAdmin
      .patch(`/api/erp/ordenes_trabajo/${id}/estado`)
      .send({ estado: "cancelada" });
    expect(otraVez.status).toBe(409);
  });

  it("carrera: dos PATCH /:id/estado casi simultáneos, solo uno gana", async () => {
    const creada = await agenteAdmin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, titulo: "Carrera de estado" });
    const id = creada.body.id;
    await agenteAdmin
      .patch(`/api/erp/ordenes_trabajo/${id}/estado`)
      .send({ estado: "en_progreso" });

    const [a, b] = await Promise.all([
      agenteAdmin.patch(`/api/erp/ordenes_trabajo/${id}/estado`).send({ estado: "completada" }),
      agenteAdmin.patch(`/api/erp/ordenes_trabajo/${id}/estado`).send({ estado: "cancelada" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("edita campos no-estado con PUT, equipo_id no forma parte del body de edición", async () => {
    const creada = await agenteAdmin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, titulo: "Original" });
    const id = creada.body.id;

    const editada = await agenteAdmin.put(`/api/erp/ordenes_trabajo/${id}`).send({
      titulo: "Actualizado",
      tipo: "preventivo",
      prioridad: "alta",
    });
    expect(editada.status).toBe(200);
    expect(editada.body.titulo).toBe("Actualizado");
    expect(editada.body.tipo).toBe("preventivo");
    expect(editada.body.equipo_id).toBe(equipoId);
  });

  it("reintento con mismo cliente_uuid crea UNA sola OT y devuelve el mismo id", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = { cliente_uuid: clienteUuid, equipo_id: equipoId, titulo: "Reintento" };

    const primera = await agenteAdmin.post("/api/erp/ordenes_trabajo").send(cuerpo);
    expect(primera.status).toBe(201);

    const reintento = await agenteAdmin.post("/api/erp/ordenes_trabajo").send(cuerpo);
    expect(reintento.status).toBe(200);
    expect(reintento.body.id).toBe(primera.body.id);
  });

  it("eliminar solo admin (403 para operador), operador SÍ puede crear y transicionar", async () => {
    const emailOperador = `${idUnico("operador")}@test.local`;
    const altaOperador = await request(app)
      .post(`/api/platform/tenants/${tenantId}/usuarios`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({ nombre: "Operador OT", email: emailOperador, password, rol: "operador" });
    expect(altaOperador.status).toBe(201);

    const agenteOperador = request.agent(app);
    await agenteOperador
      .post("/api/auth/login")
      .send({ tenantSlug, email: emailOperador, password });

    const creada = await agenteOperador
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, titulo: "Creada por operador" });
    expect(creada.status).toBe(201);

    const transicion = await agenteOperador
      .patch(`/api/erp/ordenes_trabajo/${creada.body.id}/estado`)
      .send({ estado: "en_progreso" });
    expect(transicion.status).toBe(200);

    const eliminarComoOperador = await agenteOperador.delete(
      `/api/erp/ordenes_trabajo/${creada.body.id}`
    );
    expect(eliminarComoOperador.status).toBe(403);

    const eliminarComoAdmin = await agenteAdmin.delete(
      `/api/erp/ordenes_trabajo/${creada.body.id}`
    );
    expect(eliminarComoAdmin.status).toBe(200);
  });

  it("cuota: bloquea al llegar al límite del tenant", async () => {
    await fijarCuotaTenant(tenantId, "ordenes_trabajo", 1);

    const primeraTrasReset = await agenteAdmin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, titulo: "Cuenta para la cuota" });
    // Puede que ya haya OT creadas por tests anteriores en este mismo
    // tenant, así que solo se confirma que EN ALGÚN punto cercano al
    // límite bajo el nuevo tope aparece un 403 estructurado.
    if (primeraTrasReset.status === 403) {
      expect(primeraTrasReset.body.error).toBe("cuota_excedida");
      expect(primeraTrasReset.body.recurso).toBe("ordenes_trabajo");
    } else {
      const siguiente = await agenteAdmin
        .post("/api/erp/ordenes_trabajo")
        .send({ equipo_id: equipoId, titulo: "Debe rebotar" });
      expect(siguiente.status).toBe(403);
      expect(siguiente.body.error).toBe("cuota_excedida");
      expect(siguiente.body.recurso).toBe("ordenes_trabajo");
    }

    // Se libera el tope para no interferir con tests que corran después en
    // este mismo tenant (el archivo sigue usando agenteAdmin más abajo).
    await fijarCuotaTenant(tenantId, "ordenes_trabajo", 50_000);
  });
});

describe("aislamiento entre tenants: Órdenes de Trabajo", () => {
  it("un tenant no ve ni puede tocar las OT de otro", async () => {
    const password = "ClaveDePrueba123";
    const t1 = await crearTenantDePrueba(password);
    const t2 = await crearTenantDePrueba(password);
    try {
      const agente1 = request.agent(app);
      await agente1
        .post("/api/auth/login")
        .send({ tenantSlug: t1.tenant.slug, email: t1.usuario.email, password });
      const agente2 = request.agent(app);
      await agente2
        .post("/api/auth/login")
        .send({ tenantSlug: t2.tenant.slug, email: t2.usuario.email, password });

      const equipo1 = await agente1
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("AISL-EQ"), tipo: "Camioneta" });

      const ot1 = await agente1
        .post("/api/erp/ordenes_trabajo")
        .send({ equipo_id: equipo1.body.id, titulo: "OT del tenant 1" });
      expect(ot1.status).toBe(201);

      // El tenant 2 no puede crear una OT contra un equipo del tenant 1.
      const otCruzada = await agente2
        .post("/api/erp/ordenes_trabajo")
        .send({ equipo_id: equipo1.body.id, titulo: "Intento cruzado" });
      expect(otCruzada.status).toBe(400);

      const verDesdeT2 = await agente2.get(`/api/erp/ordenes_trabajo/${ot1.body.id}`);
      expect(verDesdeT2.status).toBe(404);

      const listadoT2 = await agente2.get("/api/erp/ordenes_trabajo");
      const idsT2 = (listadoT2.body.data as { id: number }[]).map((f) => f.id);
      expect(idsT2).not.toContain(ot1.body.id);
    } finally {
      await borrarTenantDePrueba(t1.tenant.id);
      await borrarTenantDePrueba(t2.tenant.id);
    }
  });
});

// Un solo cierre de pool para todo el archivo — closeDatabase() dentro de
// un afterAll de un describe individual rompía el segundo describe (el
// pool ya estaba cerrado cuando le tocaba correr) -- mismo gotcha ya
// documentado en tests/equipos-checklist-iperc.test.ts.
afterAll(async () => {
  await closeDatabase();
});
