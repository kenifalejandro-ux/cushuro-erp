/** tests/documentos-archivo.test.ts
 *
 * Archivo real adjunto a un documento (PDF/imagen + versionado, migración
 * 0043) -- integración HTTP contra Postgres real, con el driver "local"
 * que fija tests/setup.storage.ts para TODA la suite (no hacen falta
 * credenciales de R2 para correr esto, y una máquina que sí las tenga
 * configuradas no escribe en el bucket real).
 * El driver "s3"/R2 en sí (subida, presigned URL) ya se prueba a nivel
 * unitario con mocks en tests/document-storage.test.ts -- acá lo que
 * importa es el flujo completo: multer, permisos por rol, 404s, y que lo
 * que se descarga sea BYTE A BYTE lo que se subió.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { existsSync } from "fs";
import path from "path";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { crearUsuarioService } from "../src/server/services/auth.service";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";

const PDF_DE_PRUEBA = Buffer.from("%PDF-1.4\n%mincoreerp-test\n");

describe("documentos: archivo adjunto (versiones)", () => {
  let tenantId: string;
  let tenantSlug: string;
  let documentoId: number;
  const password = "ClaveDePrueba123";
  const agentAdmin = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agentAdmin
      .post("/api/auth/login")
      .send({ tenantSlug, email: creado.usuario.email, password });

    const doc = await agentAdmin.post("/api/erp/documentos").send({
      nombre_documento: "Licencia con archivo",
      responsable: "Juan Pérez",
      fecha_vencimiento: "2030-01-01",
    });
    documentoId = doc.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("un documento recién creado no tiene versiones", async () => {
    const res = await agentAdmin.get(`/api/erp/documentos/${documentoId}/versiones`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("sube una versión y la deja listada", async () => {
    const subida = await agentAdmin
      .post(`/api/erp/documentos/${documentoId}/versiones`)
      .attach("archivo", PDF_DE_PRUEBA, {
        filename: "licencia.pdf",
        contentType: "application/pdf",
      });

    expect(subida.status).toBe(201);
    expect(subida.body.nombre_original).toBe("licencia.pdf");
    expect(subida.body.mime_type).toBe("application/pdf");
    expect(subida.body.tamano_bytes).toBe(PDF_DE_PRUEBA.length);

    const lista = await agentAdmin.get(`/api/erp/documentos/${documentoId}/versiones`);
    expect(lista.status).toBe(200);
    expect(lista.body).toHaveLength(1);
    expect(lista.body[0].nombre_original).toBe("licencia.pdf");
  });

  it("descarga la versión y el contenido es byte a byte el original", async () => {
    const lista = await agentAdmin.get(`/api/erp/documentos/${documentoId}/versiones`);
    const versionId = lista.body[0].id;

    const descarga = await agentAdmin
      .get(`/api/erp/documentos/${documentoId}/versiones/${versionId}/descarga`)
      .buffer(true)
      .parse((res, callback) => {
        const partes: Buffer[] = [];
        res.on("data", (chunk: Buffer) => partes.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(partes)));
      });

    expect(descarga.status).toBe(200);
    expect(descarga.headers["content-type"]).toContain("application/pdf");
    expect((descarga.body as Buffer).equals(PDF_DE_PRUEBA)).toBe(true);
  });

  it("subir una segunda versión la deja primera en la lista (más reciente primero)", async () => {
    const segundoContenido = Buffer.from("%PDF-1.4\n%version-2\n");
    await agentAdmin
      .post(`/api/erp/documentos/${documentoId}/versiones`)
      .attach("archivo", segundoContenido, {
        filename: "licencia-v2.pdf",
        contentType: "application/pdf",
      });

    const lista = await agentAdmin.get(`/api/erp/documentos/${documentoId}/versiones`);
    expect(lista.body).toHaveLength(2);
    expect(lista.body[0].nombre_original).toBe("licencia-v2.pdf");
  });

  it("rechaza un tipo de archivo no permitido con 400", async () => {
    const res = await agentAdmin
      .post(`/api/erp/documentos/${documentoId}/versiones`)
      .attach("archivo", Buffer.from("no soy un pdf"), {
        filename: "malware.exe",
        contentType: "application/x-msdownload",
      });
    expect(res.status).toBe(400);
  });

  it("rechaza un archivo que supera los 10 MB con 400", async () => {
    const archivoGrande = Buffer.alloc(11 * 1024 * 1024, 1);
    const res = await agentAdmin
      .post(`/api/erp/documentos/${documentoId}/versiones`)
      .attach("archivo", archivoGrande, { filename: "grande.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
  });

  it("subir un archivo a un documento inexistente da 404", async () => {
    const res = await agentAdmin
      .post("/api/erp/documentos/999999999/versiones")
      .attach("archivo", PDF_DE_PRUEBA, { filename: "x.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(404);
  });

  it("descargar una versión inexistente da 404", async () => {
    const res = await agentAdmin.get(
      `/api/erp/documentos/${documentoId}/versiones/999999999/descarga`
    );
    expect(res.status).toBe(404);
  });

  it("borrar el documento borra también los archivos del storage (sin huérfanos)", async () => {
    const doc = await agentAdmin.post("/api/erp/documentos").send({
      nombre_documento: "Documento a borrar con archivo",
      responsable: "X",
      fecha_vencimiento: "2030-01-01",
    });
    const docId = doc.body.id;

    await agentAdmin
      .post(`/api/erp/documentos/${docId}/versiones`)
      .attach("archivo", PDF_DE_PRUEBA, { filename: "v1.pdf", contentType: "application/pdf" });
    await agentAdmin
      .post(`/api/erp/documentos/${docId}/versiones`)
      .attach("archivo", PDF_DE_PRUEBA, { filename: "v2.pdf", contentType: "application/pdf" });

    // La storage_key no se expone por la API a propósito -- se lee de la
    // base para poder verificar el archivo real en disco.
    const keys = await withTenant(tenantId, async (client) => {
      const res = await client.query<{ storage_key: string }>(
        "SELECT storage_key FROM documentos_versiones WHERE tenant_id = $1 AND documento_id = $2",
        [tenantId, docId]
      );
      return res.rows.map((r) => path.join(env.documentosDir, r.storage_key));
    });

    expect(keys).toHaveLength(2);
    for (const ruta of keys) expect(existsSync(ruta)).toBe(true);

    const borrado = await agentAdmin.delete(`/api/erp/documentos/${docId}`);
    expect(borrado.status).toBe(200);

    for (const ruta of keys) expect(existsSync(ruta)).toBe(false);
  });

  it("un usuario con rol 'lectura' puede listar/descargar pero no subir (403)", async () => {
    const email = `lectura-archivo-${Date.now()}@test.local`;
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Solo lectura", email, password, rol: "lectura" },
        client
      )
    );

    const agentLectura = request.agent(app);
    await agentLectura.post("/api/auth/login").send({ tenantSlug, email, password });

    const lista = await agentLectura.get(`/api/erp/documentos/${documentoId}/versiones`);
    expect(lista.status).toBe(200);

    const intentoSubir = await agentLectura
      .post(`/api/erp/documentos/${documentoId}/versiones`)
      .attach("archivo", PDF_DE_PRUEBA, { filename: "x.pdf", contentType: "application/pdf" });
    expect(intentoSubir.status).toBe(403);
  });
});
