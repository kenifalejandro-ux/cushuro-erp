/** tests/document-storage.test.ts
 *
 * Unit tests de src/server/services/documentStorage.ts -- los dos drivers
 * (local y s3) detrás de la misma interfaz, y las validaciones de key.
 *
 * El mock de @aws-sdk/client-s3 es una versión recortada del que ya usa
 * tests/platform-backup-s3.test.ts (mismo mecanismo de bucket en memoria):
 * acá alcanza con Put/Get/Delete/HeadBucket porque los archivos de prueba
 * son chicos (nunca disparan el multipart de @aws-sdk/lib-storage, que
 * arranca recién sobre 5 MiB).
 *
 * getSignedUrl de @aws-sdk/s3-request-presigner SÍ se reemplaza por
 * completo (no un fake S3Client): el presigner real inspecciona
 * client.config/middlewareStack de un S3Client genuino para firmar, algo
 * que un mock a mano de S3Client (como el de abajo, que solo implementa
 * .send()) no puede sostener. No hace falta probar que AWS firma bien --
 * alcanza con probar que este código LLAMA a getSignedUrl con el
 * Bucket/Key/disposition correctos y arma el resultado esperado con lo que
 * devuelve.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Readable } from "stream";

const bucketFalso = new Map<string, { cuerpo: Buffer; contentType?: string }>();
const llamadasGetSignedUrl: { bucket: string; key: string; disposition: string }[] = [];

vi.mock("@aws-sdk/client-s3", async () => {
  class ComandoBase {
    constructor(public input: any) {}
  }
  class PutObjectCommand extends ComandoBase {}
  class GetObjectCommand extends ComandoBase {}
  class DeleteObjectCommand extends ComandoBase {}
  class HeadBucketCommand extends ComandoBase {}

  class S3Client {
    public config: any;
    constructor(config: any) {
      this.config = {
        ...config,
        endpoint: async () => ({
          hostname: "s3.fake.local",
          port: undefined,
          protocol: "https:",
          path: "/",
        }),
      };
    }

    async send(comando: any): Promise<any> {
      const { input } = comando;
      switch (comando.constructor.name) {
        case "PutObjectCommand": {
          const cuerpo = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(input.Body);
          bucketFalso.set(input.Key, { cuerpo, contentType: input.ContentType });
          return { ETag: '"falso"' };
        }
        case "GetObjectCommand": {
          const objeto = bucketFalso.get(input.Key);
          if (!objeto) {
            const err = new Error("NoSuchKey");
            err.name = "NoSuchKey";
            throw err;
          }
          return { Body: Readable.from([objeto.cuerpo]) };
        }
        case "DeleteObjectCommand": {
          bucketFalso.delete(input.Key);
          return {};
        }
        case "HeadBucketCommand":
          return {};
        default:
          throw new Error(`Comando S3 no soportado por el mock: ${comando.constructor.name}`);
      }
    }
  }

  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_client: unknown, command: any) => {
    llamadasGetSignedUrl.push({
      bucket: command.input.Bucket,
      key: command.input.Key,
      disposition: command.input.ResponseContentDisposition,
    });
    return `https://fake-presigned.test/${encodeURIComponent(command.input.Key)}?firma=falsa`;
  }),
}));

const {
  driverDeEscrituraDocumentos,
  construirKeyDocumento,
  guardarArchivoDocumento,
  obtenerDescarga,
  borrarArchivoDocumento,
  sanearNombreArchivo,
} = await import("../src/server/services/documentStorage");
const { resetearClienteS3 } = await import("../src/server/services/platformBackupS3");
const { env } = await import("../src/server/config/env");

const TENANT_ID = "11111111-2222-4333-8444-555555555555";

function activarS3() {
  env.documentosStorageDriver = "s3";
  env.s3BucketName = "mincore-documentos-test";
  resetearClienteS3();
}

function activarLocal(dir: string) {
  env.documentosStorageDriver = "local";
  env.documentosDir = dir;
  resetearClienteS3();
}

let dirTemporal: string;

beforeEach(async () => {
  bucketFalso.clear();
  llamadasGetSignedUrl.length = 0;
  dirTemporal = await mkdtemp(path.join(tmpdir(), "mincoreerp-documentos-"));
});

afterAll(async () => {
  if (dirTemporal) await rm(dirTemporal, { recursive: true, force: true });
});

describe("construirKeyDocumento / sanearNombreArchivo", () => {
  it("arma una key bajo documentos/tenants/{tenant}/{documento}/ con el nombre saneado", () => {
    const key = construirKeyDocumento(TENANT_ID, 42, "licencia de conducir (1).pdf");
    expect(key).toMatch(
      new RegExp(
        `^documentos/tenants/${TENANT_ID}/42/\\d+-[0-9a-f]{8}-licencia_de_conducir__1_\\.pdf$`
      )
    );
  });

  it("sanearNombreArchivo neutraliza intentos de path traversal", () => {
    expect(sanearNombreArchivo("../../etc/passwd")).toBe("passwd");
    // En POSIX "\" no es separador de directorio -- path.basename() no lo
    // reconoce, así que lo importante es que la regex lo neutralice a "_":
    // sin "/" real en el resultado, no hay con qué escapar del directorio,
    // aunque el string siga conteniendo la substring "..".
    expect(sanearNombreArchivo("..\\..\\windows\\win.ini")).not.toContain("/");
    expect(sanearNombreArchivo("..\\..\\windows\\win.ini")).not.toContain("\\");
  });
});

describe("driver local", () => {
  beforeEach(() => activarLocal(dirTemporal));

  it("driverDeEscrituraDocumentos refleja DOCUMENTOS_STORAGE_DRIVER", () => {
    expect(driverDeEscrituraDocumentos()).toBe("local");
  });

  it("guarda el buffer en disco y lo devuelve tal cual al descargar", async () => {
    const key = construirKeyDocumento(TENANT_ID, 1, "certificado.pdf");
    const contenido = Buffer.from("%PDF-1.4 contenido de prueba");

    const guardado = await guardarArchivoDocumento(key, contenido, "application/pdf");
    expect(guardado.driver).toBe("local");
    expect(guardado.bytes).toBe(contenido.length);

    const descarga = await obtenerDescarga(
      guardado.driver,
      key,
      "certificado.pdf",
      "application/pdf"
    );
    expect(descarga.tipo).toBe("stream");
    if (descarga.tipo === "stream") {
      expect(descarga.contenido.equals(contenido)).toBe(true);
    }
  });

  it("borrarArchivoDocumento no tira si el archivo ya no existe", async () => {
    const key = construirKeyDocumento(TENANT_ID, 1, "no-existe.pdf");
    await expect(borrarArchivoDocumento("local", key)).resolves.toBeUndefined();
  });

  it("rechaza una key con path traversal (defensa en profundidad)", async () => {
    await expect(
      guardarArchivoDocumento("../../../etc/passwd", Buffer.from("x"), "application/pdf")
    ).rejects.toThrow(/inválida/);
  });
});

describe("driver s3", () => {
  beforeEach(() => activarS3());

  it("sube preservando el Content-Type real (no octet-stream, a diferencia de los backups)", async () => {
    const key = construirKeyDocumento(TENANT_ID, 2, "foto.jpg");
    const contenido = Buffer.from("contenido-jpg-de-prueba");

    const guardado = await guardarArchivoDocumento(key, contenido, "image/jpeg");
    expect(guardado.driver).toBe("s3");
    expect(bucketFalso.get(key)?.contentType).toBe("image/jpeg");
  });

  it("obtenerDescarga devuelve un redirect con URL firmada, pidiendo el Bucket/Key correctos", async () => {
    const key = construirKeyDocumento(TENANT_ID, 2, "foto.jpg");
    await guardarArchivoDocumento(key, Buffer.from("x"), "image/jpeg");

    const descarga = await obtenerDescarga("s3", key, "foto.jpg", "image/jpeg");
    expect(descarga.tipo).toBe("redirect");
    if (descarga.tipo === "redirect") {
      expect(descarga.url).toContain("fake-presigned.test");
    }
    expect(llamadasGetSignedUrl).toHaveLength(1);
    expect(llamadasGetSignedUrl[0].bucket).toBe("mincore-documentos-test");
    expect(llamadasGetSignedUrl[0].key).toBe(key);
    expect(llamadasGetSignedUrl[0].disposition).toContain("foto.jpg");
  });

  it("borrarArchivoDocumento saca el objeto del bucket", async () => {
    const key = construirKeyDocumento(TENANT_ID, 2, "borrar.jpg");
    await guardarArchivoDocumento(key, Buffer.from("x"), "image/jpeg");
    expect(bucketFalso.has(key)).toBe(true);

    await borrarArchivoDocumento("s3", key);
    expect(bucketFalso.has(key)).toBe(false);
  });
});
