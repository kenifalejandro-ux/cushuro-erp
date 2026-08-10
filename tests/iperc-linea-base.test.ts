import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("IPERC: Línea Base + Continuo/Específico referenciando el catálogo", () => {
  let tenantId: string;
  let lineaBaseId: number;
  let lineaBaseItemId: number;
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
    await closeDatabase();
  });

  it("crea una línea base con ítems y la aprueba", async () => {
    const res = await agentAdmin.post("/api/erp/iperc/lineas-base").send({
      proceso_actividad: "Carguío y acarreo",
      area_frente: "Frente Sur",
      items: [
        {
          etapa_actividad: "Carguío de material",
          peligro: "Material inestable",
          riesgo: "Deslizamiento",
          probabilidad: 4,
          severidad: 3,
          medidas_control: "Inspección de talud, distancia de seguridad",
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.items[0].nivel_riesgo).toBe(12);
    lineaBaseId = res.body.id;
    lineaBaseItemId = res.body.items[0].id;

    const aprobar = await agentAdmin
      .patch(`/api/erp/iperc/lineas-base/${lineaBaseId}/estado`)
      .send({ estado: "aprobado" });
    expect(aprobar.status).toBe(200);
    expect(aprobar.body.estado).toBe("aprobado");
  });

  it("un IPERC continuo que referencia un ítem de la línea base copia el texto del catálogo, ignora lo que mande el cliente", async () => {
    const res = await agentAdmin.post("/api/erp/iperc").send({
      tipo: "continuo",
      area_frente: "Frente Sur",
      turno: "día",
      linea_base_id: lineaBaseId,
      items: [
        {
          linea_base_item_id: lineaBaseItemId,
          // si el cliente manda texto manual junto a la referencia, se ignora
          peligro: "esto no debería guardarse",
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.items[0].peligro).toBe("Material inestable"); // vino del catálogo, no del cliente
    expect(res.body.items[0].nivel_riesgo).toBe(12);
    expect(res.body.items[0].linea_base_item_id).toBe(lineaBaseItemId);
  });

  it("un IPERC específico sin línea base, con texto libre, sigue funcionando", async () => {
    const res = await agentAdmin.post("/api/erp/iperc").send({
      tipo: "especifico",
      area_frente: "Taller",
      tarea_especifica: "Izaje de motor con grúa",
      items: [
        {
          etapa_actividad: "Izaje",
          peligro: "Caída de carga suspendida",
          riesgo: "Golpe/aplastamiento",
          probabilidad: 2,
          severidad: 4,
          medidas_control: "Uso de eslingas certificadas, zona restringida",
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.tipo).toBe("especifico");
    expect(res.body.items[0].nivel_riesgo).toBe(8);
  });

  it("rechaza un IPERC específico sin tarea_especifica (400)", async () => {
    const res = await agentAdmin.post("/api/erp/iperc").send({
      tipo: "especifico",
      area_frente: "Taller",
      items: [
        {
          etapa_actividad: "X",
          peligro: "X",
          riesgo: "X",
          probabilidad: 1,
          severidad: 1,
          medidas_control: "X",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rechaza un ítem sin linea_base_item_id y sin campos manuales completos (400)", async () => {
    const res = await agentAdmin.post("/api/erp/iperc").send({
      area_frente: "Frente Sur",
      items: [{ peligro: "Solo esto, falta el resto" }],
    });
    expect(res.status).toBe(400);
  });

  // Antes el UPDATE de cambiarEstadoLineaBase no verificaba el estado
  // actual: dos aprobaciones/rechazos casi simultáneos (ej. supervisor y
  // gerente en el mismo IPERC) se pisaban en silencio, ambos con 200.
  it("una segunda aprobación/rechazo sobre una línea base ya procesada devuelve 409, no la pisa en silencio", async () => {
    const crear = await agentAdmin.post("/api/erp/iperc/lineas-base").send({
      proceso_actividad: "Voladura",
      area_frente: "Frente Norte",
      items: [
        {
          etapa_actividad: "Carga de explosivos",
          peligro: "Detonación prematura",
          riesgo: "Fatalidad",
          probabilidad: 2,
          severidad: 4,
          medidas_control: "Protocolo de voladura, distancia de seguridad",
        },
      ],
    });
    expect(crear.status).toBe(201);
    const idLineaBase = crear.body.id;

    const primeraAprobacion = await agentAdmin
      .patch(`/api/erp/iperc/lineas-base/${idLineaBase}/estado`)
      .send({ estado: "aprobado" });
    expect(primeraAprobacion.status).toBe(200);
    expect(primeraAprobacion.body.estado).toBe("aprobado");

    const segundoIntento = await agentAdmin
      .patch(`/api/erp/iperc/lineas-base/${idLineaBase}/estado`)
      .send({ estado: "rechazado" });
    expect(segundoIntento.status).toBe(409);
    expect(segundoIntento.body.message).toContain("aprobado");

    // El estado real en la base sigue siendo el de la PRIMERA aprobación
    // -- el segundo intento no debe haber dejado ningún rastro de escritura.
    const detalle = await agentAdmin.get(`/api/erp/iperc/lineas-base/${idLineaBase}`);
    expect(detalle.body.estado).toBe("aprobado");
  });

  it("dos aprobaciones simultáneas sobre la misma línea base: exactamente una gana", async () => {
    const crear = await agentAdmin.post("/api/erp/iperc/lineas-base").send({
      proceso_actividad: "Perforación",
      area_frente: "Frente Este",
      items: [
        {
          etapa_actividad: "Perforación de taladros",
          peligro: "Proyección de partículas",
          riesgo: "Lesión ocular",
          probabilidad: 3,
          severidad: 2,
          medidas_control: "Lentes de seguridad, pantalla facial",
        },
      ],
    });
    expect(crear.status).toBe(201);
    const idLineaBase = crear.body.id;

    const [respuestaA, respuestaB] = await Promise.all([
      agentAdmin
        .patch(`/api/erp/iperc/lineas-base/${idLineaBase}/estado`)
        .send({ estado: "aprobado" }),
      agentAdmin
        .patch(`/api/erp/iperc/lineas-base/${idLineaBase}/estado`)
        .send({ estado: "rechazado" }),
    ]);

    const estados = [respuestaA.status, respuestaB.status].sort();
    expect(estados).toEqual([200, 409]);
  });
});
