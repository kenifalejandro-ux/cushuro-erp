/** src/server/services/platformBackupStorage.ts
 *
 * Dónde viven los archivos de backup. Dos drivers detrás de una sola
 * interfaz: filesystem local (default, y lo que usa la suite de tests) y
 * S3-compatible (ver platformBackupS3.ts y docs/architecture/backups-s3.md).
 *
 * ── Qué driver se usa, y por qué no es una sola variable ─────────────────
 *
 * Al ESCRIBIR manda BACKUP_STORAGE_DRIVER. Al LEER manda el driver con el
 * que se escribió ESE backup, que quedó guardado junto a la fila
 * (tenant_backups.storage / platform_backups.storage, migración 0032).
 * Son dos cosas distintas a propósito: migrar a S3 no puede volver
 * irrestaurables los backups que ya están en disco. Un despliegue que pasa
 * de local a S3 empieza a escribir en S3 y sigue pudiendo restaurar todo
 * lo viejo, sin ningún paso de migración de datos.
 *
 * ── Formato del contenido ────────────────────────────────────────────────
 *
 * Lo nuevo se guarda comprimido y cifrado (backupCrypto.ts). Los backups
 * anteriores a eso son JSON plano; al leer se detecta por los magic bytes,
 * no por la extensión ni por la fila en la base — ver esBackupCifrado().
 * Un backup viejo se sigue restaurando sin tocarlo.
 *
 * Las keys tienen la misma forma en los dos drivers (`backups/tenants/...`),
 * así que el directorio local es un espejo exacto del layout del bucket:
 * migrar a S3 puede ser literalmente un `aws s3 sync` del directorio.
 */
import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { AppError } from "../shared/middlewares/error.middleware";
import { cifrarYComprimir, descifrarYDescomprimir, esBackupCifrado, cifradoDeBackupsDisponible } from "./backupCrypto";
import { subirObjeto, descargarObjeto, borrarObjeto, borrarObjetos } from "./platformBackupS3";

export type DriverStorage = "local" | "s3";

export interface UbicacionBackup {
  storage: DriverStorage;
  /** Key completa en S3, o ruta relativa dentro de BACKUPS_DIR. */
  key: string;
}

export function driverDeEscritura(): DriverStorage {
  return env.backupStorageDriver === "s3" ? "s3" : "local";
}

/** Las keys las genera siempre el servidor (nunca vienen del cliente), pero
 *  igual se validan como defensa en profundidad: una key con ".." escaparía
 *  de BACKUPS_DIR en el driver local. Se valida en los DOS drivers para que
 *  la garantía no dependa de cuál esté activo. */
function validarKey(key: string): void {
  if (!key || key.includes("..") || key.startsWith("/") || key.includes("\\") || key.includes("\0")) {
    throw new AppError(500, `Key de backup inválida: ${key}`);
  }
}

function rutaLocal(key: string): string {
  return path.join(env.backupsDir, key);
}

async function aBuffer(stream: Readable): Promise<Buffer> {
  const partes: Buffer[] = [];
  for await (const chunk of stream) partes.push(Buffer.from(chunk));
  return Buffer.concat(partes);
}

/** Guarda el contenido (JSON plano de entrada) comprimido y cifrado, en el
 *  driver de escritura configurado. Devuelve dónde quedó y cuánto ocupa ya
 *  comprimido/cifrado — que es lo que hay que registrar en tamano_bytes,
 *  no el tamaño del JSON original.
 *
 *  ── Cuándo el cifrado es obligatorio ────────────────────────────────────
 *
 *  Con driver 's3' es OBLIGATORIO: subir a almacenamiento de un tercero un
 *  JSON que incluye usuarios.password_hash sin cifrar del lado del cliente
 *  no es una opción, ni siquiera con SSE activo (SSE protege del acceso al
 *  disco físico, no de un bucket mal configurado como público ni del
 *  proveedor). Sin BACKUP_ENCRYPTION_KEY el export falla con 503 antes de
 *  mandar un solo byte — falla cerrado.
 *
 *  Con driver 'local' es OPCIONAL, y solo por compatibilidad: los
 *  despliegues que ya venían haciendo backups a disco no configuraron esa
 *  clave nunca, y volverlos irrestaurables de un deploy al otro sería
 *  peor que el riesgo que se está mitigando. Se avisa por log en cada
 *  backup sin cifrar, no una sola vez al arrancar, para que la advertencia
 *  no se pierda entre el ruido del arranque. */
export async function guardarBackup(
  key: string,
  contenidoJson: string,
  metadata: Record<string, string> = {}
): Promise<{ ubicacion: UbicacionBackup; bytes: number }> {
  validarKey(key);
  const storage = driverDeEscritura();

  if (storage === "s3" && !cifradoDeBackupsDisponible()) {
    throw new AppError(
      503,
      "Los backups a S3 exigen BACKUP_ENCRYPTION_KEY (32 bytes en base64): no se sube contenido sin cifrar a storage de terceros"
    );
  }

  const cifrar = cifradoDeBackupsDisponible();
  if (!cifrar) {
    logger.warn(
      { key },
      "BACKUP_ENCRYPTION_KEY no configurada: el backup se guarda SIN CIFRAR en disco (contiene password_hash). " +
        "Configurala para cifrarlo — los backups viejos sin cifrar se siguen pudiendo restaurar."
    );
  }

  const fuente = Readable.from([contenidoJson]);
  const cuerpo = cifrar ? cifrarYComprimir(fuente) : fuente;

  if (storage === "s3") {
    const { bytes } = await subirObjeto(key, cuerpo, metadata);
    return { ubicacion: { storage, key }, bytes };
  }

  const destino = rutaLocal(key);
  await mkdir(path.dirname(destino), { recursive: true });
  const contenido = await aBuffer(cuerpo);
  await writeFile(destino, contenido);
  return { ubicacion: { storage, key }, bytes: contenido.length };
}

/** Devuelve el JSON plano del backup, descifrando y descomprimiendo si hace
 *  falta. Los backups viejos (JSON plano, sin cifrar) se devuelven tal cual. */
export async function leerBackup(ubicacion: UbicacionBackup): Promise<string> {
  validarKey(ubicacion.key);

  const contenido =
    ubicacion.storage === "s3"
      ? await descargarObjeto(ubicacion.key)
      : await readFile(rutaLocal(ubicacion.key));

  if (!esBackupCifrado(contenido)) {
    // Backup anterior a la migración a S3/cifrado: JSON plano en disco.
    return contenido.toString("utf-8");
  }
  return descifrarYDescomprimir(contenido);
}

/** No tira si el objeto ya no está: la retención borra objeto y fila, y
 *  tiene que poder terminar de limpiar la fila aunque el objeto ya hubiera
 *  desaparecido (lifecycle rule del bucket, borrado manual, etc.). */
export async function borrarBackup(ubicacion: UbicacionBackup): Promise<void> {
  validarKey(ubicacion.key);

  try {
    if (ubicacion.storage === "s3") {
      await borrarObjeto(ubicacion.key);
    } else {
      await unlink(rutaLocal(ubicacion.key));
    }
  } catch (err) {
    const codigo = (err as NodeJS.ErrnoException).code;
    const nombre = (err as Error).name;
    if (codigo === "ENOENT" || nombre === "NoSuchKey" || nombre === "NotFound") {
      logger.warn({ ...ubicacion }, "El objeto de backup ya no existía al intentar borrarlo, se continúa");
      return;
    }
    throw err;
  }
}

/** Borrado en lote, agrupando por driver. En S3 usa DeleteObjects (una
 *  request por cada 1000 keys en vez de una por key), que es la diferencia
 *  entre que una poda de retención tarde segundos o minutos. Devuelve las
 *  keys que no se pudieron borrar para que el llamador NO borre esas filas
 *  de la base — perder el puntero a un objeto que sigue existiendo lo
 *  convertiría en basura invisible que igual factura. */
export async function borrarBackupsEnLote(
  ubicaciones: UbicacionBackup[]
): Promise<{ borradas: string[]; fallidas: string[] }> {
  const borradas: string[] = [];
  const fallidas: string[] = [];

  const keysS3 = ubicaciones.filter((u) => u.storage === "s3").map((u) => u.key);
  if (keysS3.length > 0) {
    keysS3.forEach(validarKey);
    const resultado = await borrarObjetos(keysS3);
    borradas.push(...resultado.borradas);
    fallidas.push(...resultado.fallidas);
  }

  for (const ubicacion of ubicaciones.filter((u) => u.storage === "local")) {
    try {
      await borrarBackup(ubicacion);
      borradas.push(ubicacion.key);
    } catch (err) {
      logger.error({ err, key: ubicacion.key }, "No se pudo borrar un backup local durante la retención");
      fallidas.push(ubicacion.key);
    }
  }

  return { borradas, fallidas };
}
