/** src/server/services/backupCrypto.ts
 *
 * Compresión + cifrado de cliente para el contenido de un backup, ANTES de
 * que salga del proceso hacia el storage (ver docs/architecture/backups-s3.md).
 *
 * Separado de shared/utils/platformCrypto.ts a propósito, aunque ambos usen
 * AES-256-GCM: aquél cifra strings cortos que entran en una columna TEXT
 * (un client_secret de OIDC) y devuelve base64; éste cifra el cuerpo entero
 * de un backup, que puede ser de cientos de MB, y trabaja sobre streams.
 * También usan claves distintas a propósito (BACKUP_ENCRYPTION_KEY vs
 * APP_ENCRYPTION_KEY): un backup tiene que poder restaurarse en un entorno
 * de disaster recovery donde la clave de secretos de la app ya rotó, o
 * directamente no existe todavía.
 *
 * ── Formato del objeto cifrado ────────────────────────────────────────────
 *
 *   [ "MCB1" 4 bytes ][ IV 12 bytes ][ gzip(json) cifrado ... ][ authTag 16 bytes ]
 *   └─ cabecera, en claro ─────────┘                           └─ trailer ──────┘
 *
 * El authTag de GCM va al FINAL y no en la cabecera porque no existe hasta
 * que se cifró el último byte — es justamente lo que autentica todo el
 * contenido. Esto obliga a que el descifrado tenga el objeto completo antes
 * de empezar (no se puede verificar el tag a mitad de camino), lo cual es
 * gratis acá: el restore necesita el JSON entero en memoria para
 * JSON.parse() de todas formas. La subida, en cambio, SÍ es incremental
 * (ver cifrarYComprimir): es el lado que puede tener que mover cientos de
 * MB sin poder permitirse una copia extra de todo en RAM.
 *
 * El magic "MCB1" (MinCore Backup v1) permite detectar el formato al leer:
 * un backup viejo, en JSON plano sin comprimir, no empieza con esos bytes —
 * ver esBackupCifrado(). Así conviven los backups previos a esta migración
 * con los nuevos, sin necesidad de reescribirlos.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { createGzip, gunzipSync } from "zlib";
import { PassThrough, Readable } from "stream";
import { pipeline } from "stream/promises";
import { env } from "../config/env";
import { AppError } from "../shared/middlewares/error.middleware";

const ALGORITMO = "aes-256-gcm";
const MAGIC = Buffer.from("MCB1", "ascii");
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export const LONGITUD_CABECERA = MAGIC.length + IV_BYTES;

function claveDeBackup(): Buffer {
  if (!env.backupEncryptionKey) {
    throw new AppError(503, "Cifrado de backups no configurado (falta BACKUP_ENCRYPTION_KEY)");
  }
  const clave = Buffer.from(env.backupEncryptionKey, "base64");
  if (clave.length !== 32) {
    throw new AppError(500, "BACKUP_ENCRYPTION_KEY inválida: debe decodificar a 32 bytes en base64");
  }
  return clave;
}

/** true si BACKUP_ENCRYPTION_KEY está configurada y es válida. Se usa para
 *  fallar temprano (al empezar el export) en vez de a mitad de la subida. */
export function cifradoDeBackupsDisponible(): boolean {
  try {
    claveDeBackup();
    return true;
  } catch {
    return false;
  }
}

/** ¿Este contenido está en el formato cifrado nuevo, o es un backup viejo
 *  en JSON plano? Se decide por los 4 bytes de magic, no por la extensión
 *  del archivo: la extensión es metadato del nombre, el magic es el dato. */
export function esBackupCifrado(contenido: Buffer): boolean {
  return contenido.length >= LONGITUD_CABECERA && contenido.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Devuelve un Readable que emite el contenido ya comprimido y cifrado,
 *  incrementalmente. No materializa el resultado completo en memoria: la
 *  subida a S3 (multipart) va consumiendo este stream a medida que se
 *  produce.
 *
 *  OJO con el techo real de memoria: `fuente` hoy se construye desde un
 *  string que YA está entero en RAM (JSON.stringify del backup completo,
 *  ver platformBackup.service.ts). Este stream evita las copias
 *  ADICIONALES que implicarían comprimir y cifrar en pasos separados
 *  —cada una otra copia completa—, pero no baja el piso que impone armar
 *  ese JSON. Bajarlo de verdad requiere exportar por cursor a NDJSON, que
 *  es un rediseño del export y no de esta capa. */
export function cifrarYComprimir(fuente: Readable): Readable {
  const clave = claveDeBackup();
  const iv = randomBytes(IV_BYTES);
  const gzip = createGzip();
  const cipher = createCipheriv(ALGORITMO, clave, iv);

  const salida = new PassThrough();
  salida.write(Buffer.concat([MAGIC, iv]));

  // `{ end: false }` deja la salida abierta después de que el cipher
  // termina, para poder escribir el authTag como trailer. Sin esto,
  // PassThrough se cerraría al terminar el pipe y el tag nunca se
  // escribiría — el objeto subiría truncado y el descifrado fallaría
  // recién al restaurar, que es el peor momento para enterarse.
  cipher.pipe(salida, { end: false });
  cipher.once("end", () => salida.end(cipher.getAuthTag()));

  pipeline(fuente, gzip, cipher).catch((err) => salida.destroy(err));

  return salida;
}

/** Inverso de cifrarYComprimir, sobre el objeto ya descargado entero.
 *  Buffer y no stream a propósito: GCM no puede autenticar nada hasta
 *  tener el authTag del final, y el restore necesita el JSON completo de
 *  todas formas (ver el comentario de arriba sobre el formato). */
export function descifrarYDescomprimir(contenido: Buffer): string {
  if (!esBackupCifrado(contenido)) {
    throw new AppError(500, "El contenido del backup no está en el formato cifrado esperado");
  }
  if (contenido.length < LONGITUD_CABECERA + AUTH_TAG_BYTES) {
    throw new AppError(500, "Backup cifrado truncado: no alcanza para cabecera + auth tag");
  }

  const iv = contenido.subarray(MAGIC.length, LONGITUD_CABECERA);
  const authTag = contenido.subarray(contenido.length - AUTH_TAG_BYTES);
  const cifrado = contenido.subarray(LONGITUD_CABECERA, contenido.length - AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITMO, claveDeBackup(), iv);
  decipher.setAuthTag(authTag);

  let comprimido: Buffer;
  try {
    comprimido = Buffer.concat([decipher.update(cifrado), decipher.final()]);
  } catch {
    // decipher.final() tira si el authTag no valida: el objeto fue
    // modificado, se corrompió en tránsito, o se está usando una
    // BACKUP_ENCRYPTION_KEY distinta a la que lo cifró. Los tres casos
    // terminan igual (no se puede restaurar), pero el mensaje tiene que
    // dejar claro que no es un bug del restore.
    throw new AppError(
      500,
      "No se pudo descifrar el backup: el contenido fue alterado o la BACKUP_ENCRYPTION_KEY no es la que lo cifró"
    );
  }

  return gunzipSync(comprimido).toString("utf-8");
}
