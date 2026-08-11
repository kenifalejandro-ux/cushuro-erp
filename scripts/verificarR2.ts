/** scripts/verificarR2.ts
 *
 * Verifica que el storage de objetos (Cloudflare R2, o cualquier
 * S3-compatible) esté bien configurado, recorriendo el MISMO camino que
 * usa el módulo Documentos en producción: subir, firmar una URL de
 * descarga, bajarla por HTTP de verdad y borrar.
 *
 * Uso:
 *   npm run storage:verificar                      # contra el .env local
 *   railway run npm run storage:verificar          # contra las vars de Railway
 *
 * Por qué existe: los tests del camino S3 corren contra un mock del SDK
 * (tests/document-storage.test.ts), así que prueban la lógica propia pero
 * NO que el proveedor real acepte lo que se le manda. Justamente ahí es
 * donde aparecen las incompatibilidades entre S3-compatibles: R2 rechaza
 * el header de server-side encryption que AWS sí acepta, MinIO lo rechaza
 * salvo con KMS, el endpoint necesita forcePathStyle en algunos y en otros
 * no. Este script cierra ese hueco con una prueba de punta a punta.
 *
 * El paso 3 (bajar la URL firmada por HTTP) es el que más valor tiene:
 * una firma mal armada solo se descubre cuando un navegador real la pide,
 * y ahí ya sería un cliente sin poder abrir su documento.
 *
 * Sale con código distinto de 0 si algo falla, para poder engancharlo a un
 * chequeo automático.
 */
import { env } from "../src/server/config/env";
import { verificarAccesoBucket } from "../src/server/services/platformBackupS3";
import {
  construirKeyDocumento,
  guardarArchivoDocumento,
  obtenerDescarga,
  borrarArchivoDocumento,
} from "../src/server/services/documentStorage";

const paso = (n: number, txt: string) => console.log(`\n[${n}] ${txt}`);
const ok = (txt: string) => console.log(`    ✓ ${txt}`);
const fallo = (txt: string) => console.log(`    ✗ ${txt}`);

// Tenant inexistente a propósito: este script no toca la base de datos, y
// la key va bajo un prefijo que ningún tenant real puede reclamar.
const TENANT_DE_PRUEBA = "00000000-0000-4000-8000-000000000000";

console.log("Configuración leída:");
console.log(`  S3_ENDPOINT               = ${env.s3Endpoint || "(vacío = AWS real)"}`);
console.log(`  S3_BUCKET_NAME            = ${env.s3BucketName || "(vacío)"}`);
console.log(`  S3_REGION                 = ${env.s3Region}`);
console.log(`  S3_FORCE_PATH_STYLE       = ${env.s3ForcePathStyle}`);
console.log(`  S3_SERVER_SIDE_ENCRYPTION = ${env.s3ServerSideEncryption || "(vacío)"}`);
console.log(`  DOCUMENTOS_STORAGE_DRIVER = ${env.documentosStorageDriver}`);
console.log(`  Credenciales              = ${env.s3AccessKeyId ? "presentes" : "AUSENTES"}`);

if (env.documentosStorageDriver !== "s3") {
  console.log(
    "\n⚠ DOCUMENTOS_STORAGE_DRIVER no es 's3': los archivos irían al disco local.\n" +
      "  En un contenedor sin volumen montado (ej. Railway) eso significa que se\n" +
      "  BORRAN en cada deploy. Configuralo antes de seguir."
  );
  process.exit(1);
}

if (!env.s3BucketName || !env.s3AccessKeyId) {
  console.log("\n⚠ Falta S3_BUCKET_NAME o las credenciales. Revisá .env / las vars del entorno.");
  process.exit(1);
}

let falloAlguno = false;

paso(1, "Acceso al bucket (HeadBucket)");
const acceso = await verificarAccesoBucket();
if (!acceso.ok) {
  fallo(`no se pudo acceder: ${acceso.motivo}`);
  process.exit(1);
}
ok("el bucket existe y las credenciales alcanzan");

const contenido = Buffer.from("%PDF-1.4\n%verificacion-storage-mincoreerp\n");
const key = construirKeyDocumento(TENANT_DE_PRUEBA, 1, "verificacion.pdf");

paso(2, "Subida preservando el Content-Type real");
try {
  const { driver, bytes } = await guardarArchivoDocumento(key, contenido, "application/pdf");
  ok(`subido con driver "${driver}", ${bytes} bytes`);
  ok(`key: ${key}`);
} catch (err) {
  fallo(`falló la subida: ${(err as Error).message}`);
  process.exit(1);
}

paso(3, "URL firmada, descargada por HTTP de verdad");
try {
  const descarga = await obtenerDescarga("s3", key, "verificacion.pdf", "application/pdf");
  if (descarga.tipo !== "redirect") {
    fallo(`se esperaba un redirect y vino "${descarga.tipo}"`);
    falloAlguno = true;
  } else {
    ok("URL firmada generada");
    const res = await fetch(descarga.url);
    if (!res.ok) {
      fallo(`el proveedor rechazó la URL firmada (HTTP ${res.status})`);
      falloAlguno = true;
    } else {
      const bajado = Buffer.from(await res.arrayBuffer());
      if (bajado.equals(contenido)) ok("contenido descargado idéntico al subido");
      else {
        fallo("el contenido descargado NO coincide con el subido");
        falloAlguno = true;
      }

      const tipo = res.headers.get("content-type");
      if (tipo?.includes("application/pdf")) ok(`Content-Type correcto (${tipo})`);
      else fallo(`Content-Type inesperado: ${tipo}`);

      const disposicion = res.headers.get("content-disposition");
      if (disposicion?.includes("verificacion.pdf"))
        ok("Content-Disposition con el nombre original");
      else fallo(`Content-Disposition inesperado: ${disposicion}`);
    }
  }
} catch (err) {
  fallo(`falló la descarga firmada: ${(err as Error).message}`);
  falloAlguno = true;
}

paso(4, "Borrado (limpieza del objeto de prueba)");
try {
  await borrarArchivoDocumento("s3", key);
  ok("objeto de prueba borrado del bucket");
} catch (err) {
  fallo(`no se pudo borrar — queda un objeto suelto en ${key}: ${(err as Error).message}`);
  falloAlguno = true;
}

console.log(
  falloAlguno
    ? "\n❌ El storage NO quedó bien configurado (ver arriba)."
    : "\n✅ Storage configurado y funcionando de punta a punta."
);
process.exit(falloAlguno ? 1 : 0);
