/** src/server/services/platformBackupStorage.ts
 *
 * Dónde viven los archivos de backup — filesystem local por default
 * (BACKUPS_DIR, ver env.ts). Deliberadamente separado del resto de
 * platformBackup.service.ts: el día que haga falta S3-compatible en vez
 * de disco local, este es el único archivo que cambia — el resto del
 * flujo de export/restore no sabe ni le importa dónde termina guardado
 * cada backup.
 *
 * nombreArchivo siempre lo genera el propio servicio (nunca un valor que
 * venga del cliente) — igual se valida acá contra path traversal como
 * defensa en profundidad, no porque hoy exista una forma real de
 * explotarlo.
 */
import { mkdir, writeFile, readFile } from "fs/promises";
import path from "path";
import { env } from "../config/env";

function validarNombreArchivo(nombreArchivo: string): void {
  if (nombreArchivo.includes("..") || nombreArchivo.includes("/") || nombreArchivo.includes("\\")) {
    throw new Error(`Nombre de archivo de backup inválido: ${nombreArchivo}`);
  }
}

export async function guardarArchivoBackup(nombreArchivo: string, contenido: string): Promise<void> {
  validarNombreArchivo(nombreArchivo);
  await mkdir(env.backupsDir, { recursive: true });
  await writeFile(path.join(env.backupsDir, nombreArchivo), contenido, "utf-8");
}

export async function leerArchivoBackup(nombreArchivo: string): Promise<string> {
  validarNombreArchivo(nombreArchivo);
  return readFile(path.join(env.backupsDir, nombreArchivo), "utf-8");
}
