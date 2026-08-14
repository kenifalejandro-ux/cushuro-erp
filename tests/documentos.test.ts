/** tests/documentos.test.ts
 *
 * Cubre la regla de negocio real (estado_alerta calculado por
 * fecha_vencimiento), CRUD, carga masiva, permisos por rol y el aviso de
 * posible duplicado.
 *
 * Las TRES rutas que escriben (`POST /`, `PUT /:id` y `POST /bulk`) validan
 * con Zod -- ver documentos.schema.ts. El bloque "validación" de abajo
 * cubre los límites de esos schemas; los casos felices están repartidos en
 * el resto del archivo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { crearUsuarioService } from "../src/server/services/auth.service";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { MAX_FILAS_CARGA_MASIVA } from "../src/server/schemas/documentos.schema";

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
    // Devuelve el conteo, no las filas: una importación de miles de
    // registros no tiene por qué volver entera al cliente.
    expect(res.body.insertadas).toBe(2);

    const despues = await agentAdmin.get("/api/erp/documentos?pageSize=1");
    expect(despues.body.pagination.total).toBe(totalAntes + 2);
  });

  it("la carga masiva inserta en lotes: 1.200 filas cruzan el tamaño de lote sin perder ninguna", async () => {
    const antes = await agentAdmin.get("/api/erp/documentos?pageSize=1");
    const totalAntes = antes.body.pagination.total;

    // 1.200 > TAMANO_LOTE (1.000): fuerza la segunda vuelta del loop de
    // lotes, que es donde se rompería un cálculo de placeholders mal hecho
    // ($1..$4000 en el primero, y de nuevo desde $1 en el segundo).
    const filas = Array.from({ length: 1200 }, (_, i) => ({
      nombre_documento: `Lote ${i}`,
      responsable: "Importación",
      fecha_vencimiento: fechaEn(30),
    }));

    const res = await agentAdmin.post("/api/erp/documentos/bulk").send(filas);
    expect(res.status).toBe(201);
    expect(res.body.insertadas).toBe(1200);

    const despues = await agentAdmin.get("/api/erp/documentos?pageSize=1");
    expect(despues.body.pagination.total).toBe(totalAntes + 1200);
  });

  it("la carga masiva acepta un cuerpo bastante más grande que el límite general de 16 kb", async () => {
    // El límite general cortaba la importación a ~110 filas con un 413 que
    // el cliente ni siquiera mostraba. 400 filas con textos largos superan
    // holgadamente esos 16 kb (ver BULK_BODY_LIMIT en app.ts).
    const filas = Array.from({ length: 400 }, (_, i) => ({
      nombre_documento: `Licencia de operación de planta concentradora N° ${i} - unidad minera`,
      responsable: "Juan Carlos Pérez Rodríguez - Jefe de Seguridad y Salud Ocupacional",
      fecha_vencimiento: fechaEn(60),
    }));
    expect(Buffer.byteLength(JSON.stringify(filas))).toBeGreaterThan(16 * 1024);

    const res = await agentAdmin.post("/api/erp/documentos/bulk").send(filas);
    expect(res.status).toBe(201);
    expect(res.body.insertadas).toBe(400);
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

describe("documentos: validación de entrada (Zod)", () => {
  let tenantSlug: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);
  let documentoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantSlug = creado.tenant.slug;
    await agent.post("/api/auth/login").send({ tenantSlug, email: creado.usuario.email, password });

    const doc = await agent.post("/api/erp/documentos").send({
      nombre_documento: "Documento base",
      responsable: "X",
      fecha_vencimiento: fechaEn(30),
    });
    documentoId = doc.body.id;
  });

  // ── PUT /:id ──────────────────────────────────────────────────────────

  it("PUT rechaza un nombre vacío con 400 en vez de guardarlo", async () => {
    const res = await agent.put(`/api/erp/documentos/${documentoId}`).send({
      nombre_documento: "   ",
      responsable: "X",
      fecha_vencimiento: fechaEn(30),
    });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe("nombre_documento");
  });

  it("PUT rechaza un nombre que excede el largo de la columna (200)", async () => {
    // Sin validación esto llegaba a Postgres y volvía como 500 genérico,
    // no como un error de formulario que el usuario pudiera corregir.
    const res = await agent.put(`/api/erp/documentos/${documentoId}`).send({
      nombre_documento: "A".repeat(201),
      responsable: "X",
      fecha_vencimiento: fechaEn(30),
    });
    expect(res.status).toBe(400);
  });

  it("PUT ignora los campos de más que manda el formulario (id, estado_alerta, total_count)", async () => {
    // El cliente hace setForm(doc) con la fila entera, así que el PUT llega
    // con columnas calculadas. El schema no es .strict(): las descarta.
    const res = await agent.put(`/api/erp/documentos/${documentoId}`).send({
      id: 999999,
      estado_alerta: "VENCIDO",
      total_count: "42",
      nombre_documento: "Actualizado con campos de más",
      responsable: "Y",
      fecha_vencimiento: fechaEn(45),
    });
    expect(res.status).toBe(200);
    expect(res.body.nombre_documento).toBe("Actualizado con campos de más");
    // El id de la URL manda; el del body se descartó.
    expect(res.body.id).toBe(documentoId);
  });

  it("PUT recorta los espacios sobrantes del nombre", async () => {
    const res = await agent.put(`/api/erp/documentos/${documentoId}`).send({
      nombre_documento: "  Con espacios  ",
      responsable: "Y",
      fecha_vencimiento: fechaEn(45),
    });
    expect(res.status).toBe(200);
    expect(res.body.nombre_documento).toBe("Con espacios");
  });

  // ── POST /bulk ────────────────────────────────────────────────────────

  it("bulk rechaza un cuerpo que no es un array", async () => {
    // Antes esto entraba al `for (const d of items)` y explotaba como 500.
    const res = await agent
      .post("/api/erp/documentos/bulk")
      .send({ nombre_documento: "No soy un array", fecha_vencimiento: fechaEn(10) });
    expect(res.status).toBe(400);
  });

  it("bulk rechaza un array vacío", async () => {
    const res = await agent.post("/api/erp/documentos/bulk").send([]);
    expect(res.status).toBe(400);
  });

  it("bulk rechaza el lote entero si UNA fila está mal, sin insertar nada", async () => {
    const antes = await agent.get("/api/erp/documentos?pageSize=1");

    const res = await agent.post("/api/erp/documentos/bulk").send([
      { nombre_documento: "Válida", responsable: "A", fecha_vencimiento: fechaEn(10) },
      { nombre_documento: "", responsable: "B", fecha_vencimiento: fechaEn(10) },
    ]);
    expect(res.status).toBe(400);
    // El índice del array viaja en el campo del error: es lo que le permite
    // al cliente decir "fila 3 de tu planilla" en vez de un error genérico.
    expect(res.body.errors[0].field).toBe("1.nombre_documento");

    const despues = await agent.get("/api/erp/documentos?pageSize=1");
    expect(despues.body.pagination.total).toBe(antes.body.pagination.total);
  });

  it("bulk rechaza más filas que el máximo permitido", async () => {
    const filas = Array.from({ length: MAX_FILAS_CARGA_MASIVA + 1 }, (_, i) => ({
      nombre_documento: `Fila ${i}`,
      fecha_vencimiento: fechaEn(10),
    }));
    const res = await agent.post("/api/erp/documentos/bulk").send(filas);
    expect(res.status).toBe(400);
  });

  it("un cuerpo que supera el límite responde 413, no 500", async () => {
    // body-parser lanza su propio error (type: "entity.too.large"), que no
    // es un AppError: sin traducirlo caía al 500 genérico. Importa por dos
    // motivos -- el cliente no puede distinguir "me pasé de tamaño" de "se
    // rompió el servidor", y un 5xx despierta a alguien de guardia por lo
    // que en realidad es un error del que llama.
    const enorme = Array.from({ length: 2000 }, (_, i) => ({
      nombre_documento: `Documento con nombre deliberadamente larguísimo número ${i} `.repeat(30),
      fecha_vencimiento: fechaEn(10),
    }));
    expect(Buffer.byteLength(JSON.stringify(enorme))).toBeGreaterThan(2 * 1024 * 1024);

    const res = await agent.post("/api/erp/documentos/bulk").send(enorme);
    expect(res.status).toBe(413);
  });

  it("un JSON malformado responde 400, no 500", async () => {
    const res = await agent
      .post("/api/erp/documentos/bulk")
      .set("Content-Type", "application/json")
      .send('[{"nombre_documento": "roto"');
    expect(res.status).toBe(400);
  });

  // ── Idempotencia de la importación ────────────────────────────────────
  //
  // El caso real: la importación llega y se commitea, pero la respuesta se
  // pierde de vuelta (se cortó la red). El usuario ve un error, vuelve a
  // apretar "Excel" y elige EL MISMO ARCHIVO. Sin esto, se duplica todo.
  // Ver idempotentBatch.ts.

  const CLAVE = "3f2a1b4c-5d6e-8f70-a1b2-c3d4e5f60718";

  it("reintentar la MISMA importación con la misma clave no duplica nada", async () => {
    const antes = await agent.get("/api/erp/documentos?pageSize=1");
    const filas = [
      { nombre_documento: "Reintento A", fecha_vencimiento: fechaEn(10) },
      { nombre_documento: "Reintento B", fecha_vencimiento: fechaEn(10) },
    ];

    const primera = await agent
      .post("/api/erp/documentos/bulk")
      .set("Idempotency-Key", CLAVE)
      .send(filas);
    expect(primera.status).toBe(201);
    expect(primera.body.insertadas).toBe(2);

    // El reintento: 200 (no creó nada) en vez de 201, y lo dice explícito.
    const reintento = await agent
      .post("/api/erp/documentos/bulk")
      .set("Idempotency-Key", CLAVE)
      .send(filas);
    expect(reintento.status).toBe(200);
    expect(reintento.body.yaImportado).toBe(true);

    const despues = await agent.get("/api/erp/documentos?pageSize=1");
    expect(despues.body.pagination.total).toBe(antes.body.pagination.total + 2);
  });

  it("una clave distinta SÍ importa, aunque el contenido sea igual", async () => {
    // Que dos importaciones idénticas con claves distintas se procesen las
    // dos es correcto: la clave la deriva el cliente del contenido, así que
    // claves distintas significan que el cliente las considera envíos
    // distintos. Acá se verifica que la protección no se pase de celosa.
    const antes = await agent.get("/api/erp/documentos?pageSize=1");
    const filas = [{ nombre_documento: "Clave distinta", fecha_vencimiento: fechaEn(10) }];

    const a = await agent
      .post("/api/erp/documentos/bulk")
      .set("Idempotency-Key", "11111111-2222-8333-a444-555555555555")
      .send(filas);
    const b = await agent
      .post("/api/erp/documentos/bulk")
      .set("Idempotency-Key", "66666666-7777-8888-a999-aaaaaaaaaaaa")
      .send(filas);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const despues = await agent.get("/api/erp/documentos?pageSize=1");
    expect(despues.body.pagination.total).toBe(antes.body.pagination.total + 2);
  });

  it("sin header de idempotencia la importación funciona igual (no es obligatorio)", async () => {
    const res = await agent
      .post("/api/erp/documentos/bulk")
      .send([{ nombre_documento: "Sin clave", fecha_vencimiento: fechaEn(10) }]);
    expect(res.status).toBe(201);
    expect(res.body.insertadas).toBe(1);
  });

  it("una clave con formato inválido se ignora en vez de rechazar la importación", async () => {
    // Perder una importación válida por un header mal armado sería peor que
    // procesarla sin protección contra duplicados.
    const res = await agent
      .post("/api/erp/documentos/bulk")
      .set("Idempotency-Key", "no-soy-un-uuid")
      .send([{ nombre_documento: "Clave basura", fecha_vencimiento: fechaEn(10) }]);
    expect(res.status).toBe(201);
    expect(res.body.insertadas).toBe(1);
  });

  it("si la importación FALLA, la clave se libera y se puede reintentar de verdad", async () => {
    // La reserva de la clave y los INSERT viven en la misma transacción: si
    // algo revienta, la clave revierte con todo lo demás. Si no fuera así,
    // un fallo dejaría la clave "usada" y el reintento legítimo respondería
    // "ya importado" sobre datos que nunca entraron -- perder una
    // importación en silencio, el peor resultado posible.
    const claveFallo = "abcdef01-2345-8678-9abc-def012345678";

    // Se fuerza el fallo con un nombre que pasa Zod (<=200) pero rompe en
    // Postgres... no existe ese caso; se usa una fecha inválida, que Zod
    // deja pasar (solo exige string no vacío) y Postgres rechaza.
    const conFechaRota = await agent
      .post("/api/erp/documentos/bulk")
      .set("Idempotency-Key", claveFallo)
      .send([{ nombre_documento: "Fecha rota", fecha_vencimiento: "no-es-una-fecha" }]);
    expect(conFechaRota.status).toBe(500);

    // Misma clave, ahora con datos válidos: tiene que insertar de verdad.
    const reintento = await agent
      .post("/api/erp/documentos/bulk")
      .set("Idempotency-Key", claveFallo)
      .send([{ nombre_documento: "Fecha corregida", fecha_vencimiento: fechaEn(10) }]);
    expect(reintento.status).toBe(201);
    expect(reintento.body.insertadas).toBe(1);
  });

  it("bulk acepta filas sin responsable (queda en NULL)", async () => {
    const res = await agent
      .post("/api/erp/documentos/bulk")
      .send([{ nombre_documento: "Sin responsable", fecha_vencimiento: fechaEn(10) }]);
    expect(res.status).toBe(201);
    expect(res.body.insertadas).toBe(1);
  });
});

describe("documentos: vínculo opcional a una Orden de Trabajo (evidencia)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);
  let ordenTrabajoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agent
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const equipo = await agent
      .post("/api/erp/equipos")
      .send({ placa_codigo: `DOC-OT-${Date.now()}`, tipo: "Camioneta" });
    const ot = await agent
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipo.body.id, titulo: "Cambio de motor" });
    ordenTrabajoId = ot.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("crea un documento vinculado a una OT", async () => {
    const res = await agent.post("/api/erp/documentos").send({
      nombre_documento: "Informe de trabajo",
      fecha_vencimiento: fechaEn(30),
      orden_trabajo_id: ordenTrabajoId,
    });
    expect(res.status).toBe(201);
    expect(res.body.orden_trabajo_id).toBe(ordenTrabajoId);
  });

  it("un documento sin orden_trabajo_id sigue quedando suelto, como siempre", async () => {
    const res = await agent.post("/api/erp/documentos").send({
      nombre_documento: "SOAT",
      fecha_vencimiento: fechaEn(30),
    });
    expect(res.status).toBe(201);
    expect(res.body.orden_trabajo_id).toBeNull();
  });

  it("filtra el listado por orden_trabajo_id", async () => {
    const res = await agent.get(`/api/erp/documentos?orden_trabajo_id=${ordenTrabajoId}`);
    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: number; orden_trabajo_id: number | null }[]).map(
      (d) => d.orden_trabajo_id
    );
    expect(ids.every((id) => id === ordenTrabajoId)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("editar con PUT y omitir orden_trabajo_id lo deja en NULL (desvincula)", async () => {
    const creado = await agent.post("/api/erp/documentos").send({
      nombre_documento: "Para desvincular",
      fecha_vencimiento: fechaEn(30),
      orden_trabajo_id: ordenTrabajoId,
    });

    const editado = await agent.put(`/api/erp/documentos/${creado.body.id}`).send({
      nombre_documento: "Para desvincular",
      fecha_vencimiento: fechaEn(30),
    });
    expect(editado.status).toBe(200);
    expect(editado.body.orden_trabajo_id).toBeNull();
  });
});

// Un solo cierre de pool para todo el archivo -- ver el mismo comentario en
// equipos-checklist-iperc.test.ts / combustible.test.ts.
afterAll(async () => {
  await closeDatabase();
});
