/** src/server/services/platformBackupS3.ts
 *
 * Cliente S3 (o S3-compatible: Cloudflare R2, MinIO, Backblaze B2) para el
 * storage de backups — ver docs/architecture/backups-s3.md.
 *
 * Este archivo no sabe NADA del contenido de un backup: recibe streams y
 * keys, los sube/baja/borra. La compresión y el cifrado viven en
 * backupCrypto.ts, y la decisión de qué se guarda en platformBackup.service.ts.
 *
 * El cliente se crea perezosamente (no al importar el módulo): en un
 * despliegue con BACKUP_STORAGE_DRIVER=local —el default, y lo que usa la
 * suite de tests— nunca se instancia, así que no hace falta tener
 * credenciales ni bucket configurados para que la app arranque.
 */
import { Readable } from "stream";
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  type ServerSideEncryption,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { AppError } from "../shared/middlewares/error.middleware";

// 5 MiB es el mínimo que S3 acepta por parte (salvo la última). Con
// backups chicos —el caso normal hoy— el Upload manda un solo PutObject y
// nunca llega a partir nada; el multipart aparece solo cuando el contenido
// realmente lo justifica, sin que este código tenga que decidirlo.
const TAMANO_PARTE_BYTES = 5 * 1024 * 1024;
const PARTES_EN_PARALELO = 4;

let clienteS3: S3Client | undefined;

/** Instancia perezosa y cacheada. Con credenciales explícitas si están en
 *  el entorno; si no, se deja que el SDK use su cadena estándar (IAM role
 *  de la instancia/task, ~/.aws/credentials, etc.), que es el camino
 *  preferible en AWS real porque evita secretos de larga vida. */
export function obtenerClienteS3(): S3Client {
  if (clienteS3) return clienteS3;

  if (!env.s3BucketName) {
    throw new AppError(503, "Storage S3 no configurado (falta S3_BUCKET_NAME)");
  }

  clienteS3 = new S3Client({
    region: env.s3Region,
    ...(env.s3Endpoint ? { endpoint: env.s3Endpoint, forcePathStyle: env.s3ForcePathStyle } : {}),
    ...(env.s3AccessKeyId && env.s3SecretAccessKey
      ? { credentials: { accessKeyId: env.s3AccessKeyId, secretAccessKey: env.s3SecretAccessKey } }
      : {}),
  });

  return clienteS3;
}

/** Solo para tests: descarta la instancia cacheada para que la próxima
 *  llamada la reconstruya con la configuración actual del entorno. */
export function resetearClienteS3(): void {
  clienteS3 = undefined;
}

export function s3Configurado(): boolean {
  return Boolean(env.s3BucketName);
}

// ── Convención de keys ───────────────────────────────────────────────────
//
//   backups/tenants/{tenant_id}/{YYYY}/{MM}/backup_{tenant_id}_{TIMESTAMP}.json.gz.enc
//   backups/platform/{YYYY}/{MM}/platform_{TIMESTAMP}.json.gz.enc
//
// El particionado por {YYYY}/{MM} no es decorativo: hace que la retención
// mensual y cualquier inspección manual ("¿qué backups hay de marzo?")
// sean un ListObjectsV2 con prefijo acotado, en vez de listar y filtrar
// todos los backups históricos de ese tenant.
//
// La extensión es .json.gz.enc y NO .sql.gz.enc porque el contenido es
// JSON, no SQL: el export no usa pg_dump, arma el backup con SELECT por
// tabla dentro de withTenant() (ver platformBackup.service.ts) — es lo que
// permite remapear ids al clonar hacia otro tenant. Ponerle .sql sería
// mentir sobre lo que hay adentro.

export const PREFIJO_TENANTS = "backups/tenants";
export const PREFIJO_PLATAFORMA = "backups/platform";

/** Timestamp compacto y ordenable lexicográficamente: 20260803T014530Z.
 *  Sin `:` porque, aunque S3 los admite en una key, complican cualquier
 *  descarga a disco local (Windows los rechaza) y las URLs firmadas. */
export function timestampParaKey(fecha: Date = new Date()): string {
  return fecha.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function construirKeyTenant(tenantId: string, fecha: Date = new Date()): string {
  const anio = fecha.getUTCFullYear();
  const mes = String(fecha.getUTCMonth() + 1).padStart(2, "0");
  return `${PREFIJO_TENANTS}/${tenantId}/${anio}/${mes}/backup_${tenantId}_${timestampParaKey(fecha)}.json.gz.enc`;
}

export function construirKeyPlataforma(fecha: Date = new Date()): string {
  const anio = fecha.getUTCFullYear();
  const mes = String(fecha.getUTCMonth() + 1).padStart(2, "0");
  return `${PREFIJO_PLATAFORMA}/${anio}/${mes}/platform_${timestampParaKey(fecha)}.json.gz.enc`;
}

/** Prefijo de todos los backups de un tenant — para listar/podar sin
 *  tocar los de otro. Que cada tenant tenga su propio subárbol es lo que
 *  permite, además, escribir una IAM policy por tenant si algún día hace
 *  falta dar acceso de solo-lectura a un cliente sobre sus propios backups. */
export function prefijoTenant(tenantId: string): string {
  return `${PREFIJO_TENANTS}/${tenantId}/`;
}

// ── Operaciones ──────────────────────────────────────────────────────────

function paramsDeCifradoServidor() {
  if (!env.s3ServerSideEncryption) return {};
  return {
    ServerSideEncryption: env.s3ServerSideEncryption as ServerSideEncryption,
    ...(env.s3SseKmsKeyId ? { SSEKMSKeyId: env.s3SseKmsKeyId } : {}),
  };
}

/** Sube un stream con multipart automático. Devuelve los bytes realmente
 *  escritos, contados a medida que pasan: el llamador no puede saberlos de
 *  antemano porque el contenido se comprime y cifra al vuelo.
 *
 *  El contenido ya viaja cifrado del lado del cliente (backupCrypto.ts);
 *  el SSE de acá es una segunda capa, sobre la que el operador del bucket
 *  tiene control pero nosotros no. Las dos juntas cubren amenazas
 *  distintas: SSE protege contra alguien con acceso al almacenamiento
 *  físico o al bucket; el cifrado de cliente protege incluso contra el
 *  proveedor de S3 y contra un bucket mal configurado como público. */
export async function subirObjeto(
  key: string,
  cuerpo: Readable,
  metadata: Record<string, string> = {}
): Promise<{ bytes: number }> {
  let bytes = 0;
  cuerpo.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });

  const upload = new Upload({
    client: obtenerClienteS3(),
    params: {
      Bucket: env.s3BucketName,
      Key: key,
      Body: cuerpo,
      ContentType: "application/octet-stream",
      Metadata: metadata,
      ...paramsDeCifradoServidor(),
    },
    queueSize: PARTES_EN_PARALELO,
    partSize: TAMANO_PARTE_BYTES,
    // Sin esto, un fallo a mitad de un multipart deja las partes ya
    // subidas ocupando espacio (y facturando) hasta que una lifecycle rule
    // de AbortIncompleteMultipartUpload las limpie.
    leavePartsOnError: false,
  });

  try {
    await upload.done();
  } catch (err) {
    throw traducirErrorDeSubida(err);
  }
  return { bytes };
}

/** Traduce los fallos de S3 que tienen una causa concreta y accionable, en
 *  vez de dejar que lleguen como un 500 genérico cuyo motivo real solo
 *  aparece en los logs.
 *
 *  El caso del SSE se encontró probando contra MinIO real: rechaza
 *  `ServerSideEncryption: AES256` con NotImplemented si no tiene KMS
 *  configurado. Es el tipo de incompatibilidad que ningún mock del SDK
 *  puede reproducir, y que sin este mensaje se diagnostica leyendo logs
 *  durante un incidente. */
function traducirErrorDeSubida(err: unknown): unknown {
  const nombre = (err as Error)?.name ?? "";
  const mensaje = (err as Error)?.message ?? "";

  const rechazaSse =
    (nombre === "NotImplemented" || nombre === "InvalidArgument") &&
    /encryption|kms/i.test(mensaje) &&
    Boolean(env.s3ServerSideEncryption);

  if (rechazaSse) {
    return new AppError(
      503,
      `El proveedor S3 rechazó el cifrado del lado del servidor (S3_SERVER_SIDE_ENCRYPTION=${env.s3ServerSideEncryption}): ` +
        `"${mensaje}". MinIO y otros S3-compatible no lo soportan sin KMS configurado. ` +
        `Dejá S3_SERVER_SIDE_ENCRYPTION vacío para desactivarlo — el backup igual viaja cifrado del lado del cliente (AES-256-GCM).`
    );
  }

  return err;
}

/** Descarga el objeto completo a un Buffer. Buffer y no stream a
 *  propósito: el descifrado GCM necesita el authTag del final antes de
 *  poder autenticar nada, y el restore necesita el JSON entero para
 *  JSON.parse() — ver el comentario de formato en backupCrypto.ts. */
export async function descargarObjeto(key: string): Promise<Buffer> {
  const respuesta = await obtenerClienteS3().send(
    new GetObjectCommand({ Bucket: env.s3BucketName, Key: key })
  );

  if (!respuesta.Body) {
    throw new AppError(500, `El objeto ${key} vino sin cuerpo desde S3`);
  }

  const partes: Buffer[] = [];
  for await (const chunk of respuesta.Body as Readable) {
    partes.push(Buffer.from(chunk));
  }
  return Buffer.concat(partes);
}

export async function borrarObjeto(key: string): Promise<void> {
  await obtenerClienteS3().send(new DeleteObjectCommand({ Bucket: env.s3BucketName, Key: key }));
}

/** Borrado en lote (hasta 1000 por request, el límite de la API). Devuelve
 *  las keys que S3 reportó como fallidas en vez de tirar: en una poda de
 *  retención, que una key falle no debe impedir borrar las demás. */
export async function borrarObjetos(keys: string[]): Promise<{ borradas: string[]; fallidas: string[] }> {
  if (keys.length === 0) return { borradas: [], fallidas: [] };

  const borradas: string[] = [];
  const fallidas: string[] = [];

  for (let i = 0; i < keys.length; i += 1000) {
    const lote = keys.slice(i, i + 1000);
    const respuesta = await obtenerClienteS3().send(
      new DeleteObjectsCommand({
        Bucket: env.s3BucketName,
        Delete: { Objects: lote.map((Key) => ({ Key })), Quiet: false },
      })
    );
    for (const ok of respuesta.Deleted ?? []) if (ok.Key) borradas.push(ok.Key);
    for (const error of respuesta.Errors ?? []) {
      if (error.Key) fallidas.push(error.Key);
      logger.error({ key: error.Key, codigo: error.Code, mensaje: error.Message }, "S3 rechazó borrar un objeto de backup");
    }
  }

  return { borradas, fallidas };
}

export interface ObjetoListado {
  key: string;
  tamanoBytes: number;
  modificadoEn: Date | undefined;
}

/** Lista con paginación resuelta adentro (S3 devuelve como máximo 1000
 *  por página). Se usa para auditar el bucket contra la base —detectar
 *  objetos huérfanos o filas que apuntan a objetos inexistentes—, no en el
 *  camino caliente de ninguna request. */
export async function listarObjetos(prefijo: string): Promise<ObjetoListado[]> {
  const cliente = obtenerClienteS3();
  const objetos: ObjetoListado[] = [];
  let continuationToken: string | undefined;

  do {
    const respuesta = await cliente.send(
      new ListObjectsV2Command({
        Bucket: env.s3BucketName,
        Prefix: prefijo,
        ContinuationToken: continuationToken,
      })
    );
    for (const objeto of respuesta.Contents ?? []) {
      if (objeto.Key) {
        objetos.push({
          key: objeto.Key,
          tamanoBytes: objeto.Size ?? 0,
          modificadoEn: objeto.LastModified,
        });
      }
    }
    continuationToken = respuesta.IsTruncated ? respuesta.NextContinuationToken : undefined;
  } while (continuationToken);

  return objetos;
}

/** Chequeo de arranque/diagnóstico: ¿el bucket existe y las credenciales
 *  alcanzan? Devuelve el motivo en vez de tirar, para poder reportarlo en
 *  un endpoint de salud sin envolver todo en try/catch. */
export async function verificarAccesoBucket(): Promise<{ ok: boolean; motivo?: string }> {
  try {
    await obtenerClienteS3().send(new HeadBucketCommand({ Bucket: env.s3BucketName }));
    return { ok: true };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.message : String(err) };
  }
}
