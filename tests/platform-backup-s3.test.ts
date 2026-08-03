/** tests/platform-backup-s3.test.ts
 *
 * Backups en S3: convención de keys, cifrado de cliente, subida/descarga y
 * política de retención. Ver docs/architecture/backups-s3.md.
 *
 * ── Cómo se mockea S3, y qué queda REALMENTE probado ────────────────────
 *
 * El mock reemplaza `@aws-sdk/client-s3` por un bucket en memoria que
 * responde a los mismos comandos (Put/Get/Delete/DeleteObjects/ListObjectsV2)
 * y guarda los bytes tal cual llegan. Eso deja fuera lo único que no se
 * puede probar sin una cuenta real —la conversación HTTP con AWS— y deja
 * DENTRO todo lo demás: la construcción de keys, que el contenido subido
 * esté efectivamente comprimido y cifrado (se verifica sobre los bytes del
 * bucket falso, no sobre lo que el código dice que hizo), y que el
 * roundtrip completo devuelva el JSON original.
 *
 * `@aws-sdk/lib-storage` (Upload) NO se mockea: corre de verdad contra el
 * cliente falso, así que el camino de subida por streams es el real.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Bucket en memoria compartido con el mock de abajo. `vi.mock` se hoistea
// por encima de los imports, así que esto tiene que ser una función que se
// evalúa recién al usarse, no una const capturada.
const bucketFalso = new Map<string, { cuerpo: Buffer; metadata: Record<string, string>; sse?: string }>();

vi.mock("@aws-sdk/client-s3", async () => {
  class ComandoBase {
    constructor(public input: any) {}
  }
  class PutObjectCommand extends ComandoBase {}
  class GetObjectCommand extends ComandoBase {}
  class DeleteObjectCommand extends ComandoBase {}
  class DeleteObjectsCommand extends ComandoBase {}
  class ListObjectsV2Command extends ComandoBase {}
  class HeadBucketCommand extends ComandoBase {}
  class CreateMultipartUploadCommand extends ComandoBase {}
  class UploadPartCommand extends ComandoBase {}
  class CompleteMultipartUploadCommand extends ComandoBase {}
  class AbortMultipartUploadCommand extends ComandoBase {}

  const { Readable } = await import("stream");

  // Multipart en memoria: { uploadId → { key, partes ordenadas } }. Existe
  // para que el camino de multipart real de lib-storage tenga contra qué
  // correr cuando el contenido supera el partSize.
  const multipartsEnCurso = new Map<string, { key: string; partes: Map<number, Buffer>; input: any }>();

  class S3Client {
    public config: any;

    constructor(config: any) {
      // `endpoint()` no lo usa nuestro código: lib-storage lo llama solo
      // para armar el `Location` (la URL pública del objeto) que devuelve
      // en la respuesta del Upload. Sin esto tira "config.endpointProvider
      // is not set" DESPUÉS de haber subido el objeto correctamente.
      this.config = {
        ...config,
        endpoint: async () => ({ hostname: "s3.fake.local", port: undefined, protocol: "https:", path: "/" }),
      };
    }

    /** Despacha por constructor.name y NO por instanceof: @aws-sdk/lib-storage
     *  es CJS y resuelve su propia copia de @aws-sdk/client-s3, así que los
     *  comandos que construye NO son instancias de las clases de este mock.
     *  Con instanceof, todo lo que pasara por Upload caía al `throw` final. */
    async send(comando: any): Promise<any> {
      const { input } = comando;

      switch (comando.constructor.name) {
        case "PutObjectCommand": {
          // lib-storage materializa el Body cuando el contenido entra en
          // una sola parte (el caso normal de un backup chico).
          const cuerpo = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(input.Body);
          bucketFalso.set(input.Key, {
            cuerpo,
            metadata: input.Metadata ?? {},
            sse: input.ServerSideEncryption,
          });
          return { ETag: '"falso"' };
        }

        case "CreateMultipartUploadCommand": {
          const uploadId = `upload-${multipartsEnCurso.size + 1}`;
          multipartsEnCurso.set(uploadId, { key: input.Key, partes: new Map(), input });
          return { UploadId: uploadId };
        }

        case "UploadPartCommand": {
          const enCurso = multipartsEnCurso.get(input.UploadId);
          if (!enCurso) throw new Error("UploadId desconocido");
          enCurso.partes.set(input.PartNumber, Buffer.from(input.Body));
          return { ETag: `"parte-${input.PartNumber}"` };
        }

        case "CompleteMultipartUploadCommand": {
          const enCurso = multipartsEnCurso.get(input.UploadId);
          if (!enCurso) throw new Error("UploadId desconocido");
          // Reensamblado en orden de PartNumber, igual que hace S3.
          const ordenadas = [...enCurso.partes.entries()].sort((a, b) => a[0] - b[0]).map(([, buf]) => buf);
          bucketFalso.set(enCurso.key, {
            cuerpo: Buffer.concat(ordenadas),
            metadata: enCurso.input.Metadata ?? {},
            sse: enCurso.input.ServerSideEncryption,
          });
          multipartsEnCurso.delete(input.UploadId);
          return { ETag: '"falso-multipart"' };
        }

        case "AbortMultipartUploadCommand": {
          multipartsEnCurso.delete(input.UploadId);
          return {};
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

        case "DeleteObjectsCommand": {
          const Deleted: { Key: string }[] = [];
          for (const { Key } of input.Delete.Objects) {
            bucketFalso.delete(Key);
            Deleted.push({ Key });
          }
          return { Deleted, Errors: [] };
        }

        case "ListObjectsV2Command": {
          const Contents = [...bucketFalso.entries()]
            .filter(([key]) => key.startsWith(input.Prefix ?? ""))
            .map(([key, valor]) => ({ Key: key, Size: valor.cuerpo.length, LastModified: new Date() }));
          return { Contents, IsTruncated: false };
        }

        case "HeadBucketCommand":
          return {};

        default:
          throw new Error(`Comando S3 no soportado por el mock: ${comando.constructor.name}`);
      }
    }
  }

  return {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    ListObjectsV2Command,
    HeadBucketCommand,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
  };
});

const { construirKeyTenant, construirKeyPlataforma, prefijoTenant, timestampParaKey, resetearClienteS3, listarObjetos } =
  await import("../src/server/services/platformBackupS3");
const { guardarBackup, leerBackup, borrarBackupsEnLote } = await import(
  "../src/server/services/platformBackupStorage"
);
const { esBackupCifrado, descifrarYDescomprimir } = await import("../src/server/services/backupCrypto");
const { clasificarBackupsAPodar } = await import("../src/server/services/platformBackupRetention.worker");
const { env } = await import("../src/server/config/env");
const { closeDatabase } = await import("../src/server/config/database");

const TENANT_ID = "11111111-2222-4333-8444-555555555555";

/** El driver de escritura y el bucket se leen de `env` en cada llamada, así
 *  que alcanza con mutarlo — no hace falta recargar los módulos. */
function activarS3() {
  env.backupStorageDriver = "s3";
  env.s3BucketName = "mincore-backups-test";
  resetearClienteS3();
}

function activarLocal() {
  env.backupStorageDriver = "local";
  resetearClienteS3();
}

beforeEach(() => {
  bucketFalso.clear();
  activarS3();
});

afterAll(async () => {
  activarLocal();
  await closeDatabase();
});

describe("convención de keys", () => {
  it("la key de un tenant sigue backups/tenants/{id}/{YYYY}/{MM}/backup_{id}_{TS}", () => {
    const fecha = new Date("2026-03-09T01:45:30.123Z");
    const key = construirKeyTenant(TENANT_ID, fecha);

    expect(key).toBe(
      `backups/tenants/${TENANT_ID}/2026/03/backup_${TENANT_ID}_20260309T014530Z.json.gz.enc`
    );
  });

  it("la key de plataforma va en un prefijo separado del de los tenants", () => {
    const key = construirKeyPlataforma(new Date("2026-12-31T23:59:59.000Z"));

    expect(key).toBe("backups/platform/2026/12/platform_20261231T235959Z.json.gz.enc");
    expect(key.startsWith("backups/tenants/")).toBe(false);
  });

  it("el mes va con cero a la izquierda, para que el orden lexicográfico sea el cronológico", () => {
    const enero = construirKeyTenant(TENANT_ID, new Date("2026-01-05T00:00:00Z"));
    const octubre = construirKeyTenant(TENANT_ID, new Date("2026-10-05T00:00:00Z"));

    expect(enero).toContain("/2026/01/");
    expect(octubre).toContain("/2026/10/");
    expect(enero < octubre).toBe(true);
  });

  it("el timestamp no lleva ':' (rompe descargas a disco y URLs firmadas)", () => {
    expect(timestampParaKey(new Date("2026-03-09T01:45:30.000Z"))).toBe("20260309T014530Z");
  });

  it("el prefijo de un tenant no matchea las keys de otro tenant", () => {
    const otro = "99999999-2222-4333-8444-555555555555";
    expect(construirKeyTenant(otro).startsWith(prefijoTenant(TENANT_ID))).toBe(false);
    expect(construirKeyTenant(TENANT_ID).startsWith(prefijoTenant(TENANT_ID))).toBe(true);
  });

  it("usa .json.gz.enc y no .sql: el contenido es JSON, no un dump de pg_dump", () => {
    expect(construirKeyTenant(TENANT_ID).endsWith(".json.gz.enc")).toBe(true);
  });
});

describe("subida a S3: cifrado y compresión reales", () => {
  const contenido = JSON.stringify({
    version: 1,
    tenantId: TENANT_ID,
    tablas: { usuarios: [{ id: "u1", email: "admin@ejemplo.com", password_hash: "$2b$10$secretohash" }] },
  });

  it("lo que queda en el bucket está cifrado: no contiene el texto plano", async () => {
    const key = construirKeyTenant(TENANT_ID);
    await guardarBackup(key, contenido);

    const subido = bucketFalso.get(key);
    expect(subido).toBeDefined();

    const comoTexto = subido!.cuerpo.toString("utf-8");
    // Lo que más importa: el hash de contraseña no viaja legible.
    expect(comoTexto).not.toContain("password_hash");
    expect(comoTexto).not.toContain("$2b$10$secretohash");
    expect(comoTexto).not.toContain("admin@ejemplo.com");
    expect(esBackupCifrado(subido!.cuerpo)).toBe(true);
  });

  it("comprime: el objeto pesa menos que el JSON original", async () => {
    // Contenido repetitivo, como un backup real con muchas filas parecidas.
    const grande = JSON.stringify({
      version: 1,
      tablas: { equipos: Array.from({ length: 2000 }, (_, i) => ({ id: i, tipo: "Camioneta", activo: true })) },
    });
    const key = construirKeyTenant(TENANT_ID);
    const { bytes } = await guardarBackup(key, grande);

    expect(bytes).toBeLessThan(Buffer.byteLength(grande) / 2);
    expect(bytes).toBe(bucketFalso.get(key)!.cuerpo.length);
  });

  it("pide cifrado del lado del servidor además del de cliente", async () => {
    const key = construirKeyTenant(TENANT_ID);
    await guardarBackup(key, contenido);

    expect(bucketFalso.get(key)!.sse).toBe("AES256");
  });

  it("guarda la metadata del tenant en el objeto", async () => {
    const key = construirKeyTenant(TENANT_ID);
    await guardarBackup(key, contenido, { tenant_id: TENANT_ID, tenant_slug: "acme" });

    expect(bucketFalso.get(key)!.metadata).toMatchObject({ tenant_id: TENANT_ID, tenant_slug: "acme" });
  });

  it("roundtrip: lo que se baja y descifra es idéntico a lo que se subió", async () => {
    const key = construirKeyTenant(TENANT_ID);
    await guardarBackup(key, contenido);

    const leido = await leerBackup({ storage: "s3", key });

    expect(leido).toBe(contenido);
    expect(JSON.parse(leido).tablas.usuarios[0].password_hash).toBe("$2b$10$secretohash");
  });

  it("un objeto alterado en el bucket no se puede descifrar (GCM detecta la manipulación)", async () => {
    const key = construirKeyTenant(TENANT_ID);
    await guardarBackup(key, contenido);

    const objeto = bucketFalso.get(key)!;
    objeto.cuerpo[objeto.cuerpo.length - 20] ^= 0xff; // toca el ciphertext, no el tag

    await expect(leerBackup({ storage: "s3", key })).rejects.toThrow(/alterado|BACKUP_ENCRYPTION_KEY/);
  });

  it("exige BACKUP_ENCRYPTION_KEY para subir a S3: nunca manda texto plano a un tercero", async () => {
    const claveOriginal = env.backupEncryptionKey;
    env.backupEncryptionKey = "";
    try {
      await expect(guardarBackup(construirKeyTenant(TENANT_ID), contenido)).rejects.toThrow(
        /BACKUP_ENCRYPTION_KEY/
      );
      expect(bucketFalso.size).toBe(0); // no subió nada, falló antes
    } finally {
      env.backupEncryptionKey = claveOriginal;
    }
  });
});

describe("compatibilidad hacia atrás", () => {
  it("lee un backup viejo en JSON plano sin cifrar (previo a esta migración)", async () => {
    const key = construirKeyTenant(TENANT_ID);
    const jsonPlano = JSON.stringify({ version: 1, tablas: { equipos: [] } });
    bucketFalso.set(key, { cuerpo: Buffer.from(jsonPlano, "utf-8"), metadata: {} });

    expect(await leerBackup({ storage: "s3", key })).toBe(jsonPlano);
  });

  it("el driver de LECTURA sale de la ubicación del backup, no del entorno", async () => {
    // Se escribe en local aunque el entorno esté configurado en s3...
    activarLocal();
    const key = construirKeyTenant(TENANT_ID);
    const contenido = JSON.stringify({ version: 1, tablas: {} });
    const { ubicacion } = await guardarBackup(key, contenido);
    expect(ubicacion.storage).toBe("local");

    // ...y se sigue leyendo de local después de migrar el entorno a s3.
    activarS3();
    expect(await leerBackup(ubicacion)).toBe(contenido);
    expect(bucketFalso.has(key)).toBe(false); // nunca tocó el bucket
  });
});

describe("borrado y listado", () => {
  it("borra en lote y reporta qué keys se borraron", async () => {
    const keys = [
      construirKeyTenant(TENANT_ID, new Date("2026-01-01T00:00:00Z")),
      construirKeyTenant(TENANT_ID, new Date("2026-02-01T00:00:00Z")),
    ];
    for (const key of keys) await guardarBackup(key, "{}");
    expect(bucketFalso.size).toBe(2);

    const { borradas, fallidas } = await borrarBackupsEnLote(keys.map((key) => ({ storage: "s3" as const, key })));

    expect(borradas.sort()).toEqual(keys.sort());
    expect(fallidas).toEqual([]);
    expect(bucketFalso.size).toBe(0);
  });

  it("listar por prefijo de tenant no devuelve los backups de otro tenant", async () => {
    const otro = "99999999-2222-4333-8444-555555555555";
    await guardarBackup(construirKeyTenant(TENANT_ID), "{}");
    await guardarBackup(construirKeyTenant(otro), "{}");
    await guardarBackup(construirKeyPlataforma(), "{}");

    const delTenant = await listarObjetos(prefijoTenant(TENANT_ID));

    expect(delTenant).toHaveLength(1);
    expect(delTenant[0].key).toContain(TENANT_ID);
  });
});

describe("política de retención GFS", () => {
  const ahora = new Date("2026-08-15T12:00:00Z");

  function backup(id: string, iso: string, tenantId: string | null = TENANT_ID) {
    return { id, storage: "s3" as const, storage_key: `k/${id}`, creado_en: new Date(iso), tenant_id: tenantId };
  }

  it("conserva TODOS los backups dentro de la ventana diaria", () => {
    const backups = [
      backup("hoy", "2026-08-15T01:00:00Z"),
      backup("ayer", "2026-08-14T01:00:00Z"),
      backup("hace-10-dias", "2026-08-05T01:00:00Z"),
      backup("hace-29-dias", "2026-07-17T01:00:00Z"),
    ];

    const { borrar } = clasificarBackupsAPodar(backups, { diarioDias: 30, mensualMeses: 12, ahora });

    expect(borrar).toEqual([]);
  });

  it("fuera de la ventana diaria conserva solo el PRIMERO de cada mes", () => {
    const backups = [
      backup("mayo-01", "2026-05-01T03:00:00Z"),
      backup("mayo-14", "2026-05-14T03:00:00Z"),
      backup("mayo-28", "2026-05-28T03:00:00Z"),
      backup("junio-02", "2026-06-02T03:00:00Z"),
      backup("junio-20", "2026-06-20T03:00:00Z"),
    ];

    const { conservar, borrar } = clasificarBackupsAPodar(backups, { diarioDias: 30, mensualMeses: 12, ahora });

    expect(conservar.map((b) => b.id).sort()).toEqual(["junio-02", "mayo-01"]);
    expect(borrar.map((b) => b.id).sort()).toEqual(["junio-20", "mayo-14", "mayo-28"]);
  });

  it("borra todo lo más viejo que la ventana mensual", () => {
    const backups = [
      backup("hace-13-meses", "2025-07-01T03:00:00Z"),
      backup("hace-14-meses", "2025-06-01T03:00:00Z"),
      backup("hace-6-meses", "2026-02-01T03:00:00Z"),
    ];

    const { conservar, borrar } = clasificarBackupsAPodar(backups, { diarioDias: 30, mensualMeses: 12, ahora });

    expect(conservar.map((b) => b.id)).toEqual(["hace-6-meses"]);
    expect(borrar.map((b) => b.id).sort()).toEqual(["hace-13-meses", "hace-14-meses"]);
  });

  it("el mensual se elige POR TENANT: un tenant no consume el cupo de otro", () => {
    const otroTenant = "99999999-2222-4333-8444-555555555555";
    const backups = [
      backup("a-mayo-01", "2026-05-01T03:00:00Z", TENANT_ID),
      backup("b-mayo-03", "2026-05-03T03:00:00Z", otroTenant),
      backup("b-mayo-19", "2026-05-19T03:00:00Z", otroTenant),
    ];

    const { conservar, borrar } = clasificarBackupsAPodar(backups, { diarioDias: 30, mensualMeses: 12, ahora });

    // Cada tenant conserva su propio primero de mayo.
    expect(conservar.map((b) => b.id).sort()).toEqual(["a-mayo-01", "b-mayo-03"]);
    expect(borrar.map((b) => b.id)).toEqual(["b-mayo-19"]);
  });

  it("los backups de plataforma (sin tenant) tienen su propio cupo mensual", () => {
    const backups = [
      backup("tenant-mayo", "2026-05-02T03:00:00Z", TENANT_ID),
      backup("plataforma-mayo-01", "2026-05-01T03:00:00Z", null),
      backup("plataforma-mayo-15", "2026-05-15T03:00:00Z", null),
    ];

    const { conservar, borrar } = clasificarBackupsAPodar(backups, { diarioDias: 30, mensualMeses: 12, ahora });

    expect(conservar.map((b) => b.id).sort()).toEqual(["plataforma-mayo-01", "tenant-mayo"]);
    expect(borrar.map((b) => b.id)).toEqual(["plataforma-mayo-15"]);
  });
});
