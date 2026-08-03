/**src/server7config/env.ts */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";

const rootDir = process.cwd();
const envCandidates = [
  path.resolve(rootDir, ".env"),
  path.resolve(rootDir, "client", ".env"),
];

for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

function readNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const contactDestination =
  process.env.CONTACT_EMAIL_TO || process.env.FORM_EMAIL_TO || process.env.EMAIL_USER || "";

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

export const env = {
  rootDir,
  isProduction: process.env.NODE_ENV === "production",
  port: readNumber(process.env.PORT, 3000),
  bodyLimit: process.env.BODY_LIMIT || "16kb",
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  allowedOrigins,
  recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || "",
  recaptchaSecretKey: process.env.RECAPTCHA_SECRET_KEY || "",
  recaptchaExpectedAction: process.env.RECAPTCHA_EXPECTED_ACTION || "submit",
  recaptchaMinScore: readNumber(process.env.RECAPTCHA_MIN_SCORE, 0.5),
  rateLimitWindowMs: readNumber(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  rateLimitMaxRequests: readNumber(process.env.RATE_LIMIT_MAX_REQUESTS, 5),
  // Rate limit de /api/erp/* (middleware/erpRateLimiter.ts) — separado del
  // genérico de arriba porque miden cosas distintas: aquél es por RUTA (para
  // frenar fuerza bruta contra un endpoint), éste es un presupuesto
  // compartido por todo el tráfico de un tenant. En 0 queda desactivado.
  // Ojo: un tenant detrás de una IP corporativa (NAT) comparte UN
  // presupuesto entre todo su personal — si reporta 429 en uso normal, hay
  // que subir este número, no es un ataque.
  erpRateLimitWindowMs: readNumber(process.env.ERP_RATE_LIMIT_WINDOW_MS, 60_000),
  erpRateLimitMaxRequests: readNumber(process.env.ERP_RATE_LIMIT_MAX_REQUESTS, 300),
  emailHost: process.env.EMAIL_HOST || "",
  emailPort: readNumber(process.env.EMAIL_PORT, 465),
  emailUser: process.env.EMAIL_USER || "",
  emailPass: process.env.EMAIL_PASS || "",
  emailMaxConnections: readNumber(process.env.EMAIL_MAX_CONNECTIONS, 5),
  emailMaxMessages: readNumber(process.env.EMAIL_MAX_MESSAGES, 100),
  contactDestination,
  redisUrl: process.env.REDIS_URL || "",
  redisHost: process.env.REDIS_HOST || "",
  redisPort: readNumber(process.env.REDIS_PORT, 6379),
  redisPassword: process.env.REDIS_PASSWORD || "",
  // --- VARIABLES DEL ERP ---
  dbHost: process.env.PG_HOST || "localhost",
  dbPort: readNumber(process.env.PG_PORT, 5432),
  dbUser: process.env.PG_USER || "",
  dbPass: process.env.PG_PASSWORD || "",
  dbName: process.env.PG_DATABASE || "",
  // --- AUTENTICACIÓN ---
  // Corto a propósito: la revocación real ahora la hace token_version (ver
  // authMiddleware + migrations/0003_token_version.sql), así que esta
  // duración es solo el límite superior de exposición si JWT_SECRET se
  // filtrara, no el mecanismo de logout.
  jwtExpires: process.env.JWT_EXPIRES || "30m",
  sessionTtlSeconds: readNumber(process.env.SESSION_TTL_SECONDS, 60 * 60 * 24 * 30), // 30 días
  authCookieName: process.env.AUTH_COOKIE_NAME || "erp_token",
  // "Continuar con Google": opcional — si no está seteado, el botón no se
  // renderiza en el login (ver LoginPage.tsx) y POST /api/auth/google
  // responde 503 (ver googleLoginService).
  googleLoginClientId: process.env.GOOGLE_LOGIN_CLIENT_ID || "",
  // Dominio raíz de la plataforma (ej. "mincoreerp.com"). Mientras esté
  // vacío (todavía no hay dominio comprado), el tenant siempre se resuelve
  // del campo "Empresa" del formulario — ver resolveTenantSubdomain.ts.
  // Configurado, cada cliente entra por "<slug>.<appApexDomain>" sin ver
  // ese campo; el dueño de la plataforma sigue entrando por el dominio raíz
  // (o localhost) con el campo manual, sin depender de tener su propio
  // subdominio.
  appApexDomain: (process.env.APP_APEX_DOMAIN || "").toLowerCase(),
  // Base del link que va en el correo de recuperación de contraseña
  // cuando el tenant no tiene dominio propio (dominio_personalizado) ni
  // hay appApexDomain configurado para armar un subdominio — ver
  // construirUrlTenant() en auth.service.ts. Sin protocolo final propio
  // (localhost en dev), se asume http:// si empieza con "localhost".
  appPublicUrl: process.env.APP_PUBLIC_URL || "http://localhost:5174",
  // --- PLATAFORMA (onboarding de tenants, no forma parte del login normal) ---
  // Deliberadamente NO está en requiredEnvNames: el server debe poder
  // arrancar sin esto. platformAdmin.middleware.ts falla cerrado (503) si
  // no está configurado, en vez de bloquear todo el arranque por una
  // operación que se usa rara vez.
  platformAdminToken: process.env.PLATFORM_ADMIN_TOKEN || "",
  // Duración de la sesión de login por cookie del panel (platformSession.service.ts)
  // y de la cookie misma — deben coincidir, por eso ambas leen de acá.
  platformSessionTtlMs: readNumber(process.env.PLATFORM_SESSION_TTL_MS, 12 * 60 * 60 * 1000),
  // Límite específico para POST /api/platform/tenants — separado del
  // rateLimiter genérico (form:${path}:${ip}), que comparte ventana con
  // cualquier formulario de la app y no alcanza para una acción de tanto
  // blast radius como crear un tenant nuevo.
  platformTenantCreationWindowMs: readNumber(process.env.PLATFORM_TENANT_CREATION_WINDOW_MS, 15 * 60_000),
  platformTenantCreationMaxRequests: readNumber(process.env.PLATFORM_TENANT_CREATION_MAX_REQUESTS, 5),
  // Ídem para POST /api/platform/admin-sesion — separado del rateLimiter
  // genérico por la misma razón (no queremos que subir el límite de un
  // formulario cualquiera afloje sin querer la protección contra fuerza
  // bruta de contraseñas de admin, ni viceversa). Más estricto que el
  // genérico por defecto porque acá el riesgo es adivinar una contraseña,
  // no solo abuso de formulario.
  platformAdminLoginWindowMs: readNumber(process.env.PLATFORM_ADMIN_LOGIN_WINDOW_MS, 15 * 60_000),
  platformAdminLoginMaxRequests: readNumber(process.env.PLATFORM_ADMIN_LOGIN_MAX_REQUESTS, 10),
  // Cada cuánto platformOutbox.worker.ts revisa platform_outbox por
  // eventos pendientes — un panel de administración no necesita drenar en
  // tiempo real, unos segundos de demora no le importan a nadie.
  platformOutboxPollIntervalMs: readNumber(process.env.PLATFORM_OUTBOX_POLL_INTERVAL_MS, 5000),
  // Retención de platform_audit_log — deshabilitada (0) por default a
  // propósito: guardar de más nunca rompe compliance, borrar de menos sí.
  // Ver migrations/0019_platform_audit_log_retencion.sql para la política
  // recomendada antes de configurar esto en producción.
  platformAuditRetentionDays: readNumber(process.env.PLATFORM_AUDIT_RETENTION_DAYS, 0),
  platformAuditRetentionCheckIntervalMs: readNumber(
    process.env.PLATFORM_AUDIT_RETENTION_CHECK_INTERVAL_MS,
    24 * 60 * 60_000
  ),
  // Backups de tenant (platformBackup.service.ts) — filesystem local por
  // default. El storage queda detrás de platformBackupStorage.ts a
  // propósito, para que pasar a S3-compatible el día que haga falta sea
  // cambiar ese archivo, no el resto del flujo de export/restore.
  backupsDir: process.env.BACKUPS_DIR || path.resolve(rootDir, "backups"),
  // --- BACKUPS EN S3 (ver docs/architecture/backups-s3.md) ---
  // "local" (default) o "s3". Deliberadamente explícito en vez de inferir
  // el driver de "¿hay S3_BUCKET_NAME?": una variable de S3 a medio
  // configurar no debe cambiar en silencio dónde se guardan los backups.
  // El driver solo decide dónde se ESCRIBE lo nuevo — la lectura siempre
  // respeta el driver con el que se escribió cada backup (columna
  // `storage` en tenant_backups/platform_backups), así los backups viejos
  // en disco se siguen pudiendo restaurar después de migrar a S3.
  backupStorageDriver: (process.env.BACKUP_STORAGE_DRIVER || "local").toLowerCase(),
  s3BucketName: process.env.S3_BUCKET_NAME || "",
  s3Region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
  // Vacío = AWS real. Seteado = S3-compatible (Cloudflare R2, MinIO,
  // Backblaze B2): ahí también suele hacer falta S3_FORCE_PATH_STYLE=true,
  // porque el virtual-host style (bucket.endpoint) no siempre existe.
  s3Endpoint: process.env.S3_ENDPOINT || "",
  s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  // Vacías = el SDK resuelve credenciales por su cadena estándar (IAM role
  // de la instancia/task, ~/.aws/credentials, etc.) — el camino preferible
  // en AWS real, porque evita tener secretos de larga vida en el entorno.
  s3AccessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
  s3SecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  // Cifrado del lado del cliente, ANTES de subir (ver backupCrypto.ts) —
  // no reemplaza SSE-S3, se combina con él. Separada de APP_ENCRYPTION_KEY
  // a propósito: un backup cifrado tiene que poder restaurarse en un
  // entorno nuevo (DR) donde la clave de secretos de la app puede haber
  // rotado. Base64 de 32 bytes: `openssl rand -base64 32`.
  backupEncryptionKey: process.env.BACKUP_ENCRYPTION_KEY || "",
  // Server-side encryption que se le pide a S3 además del cifrado de
  // cliente. "AES256" (SSE-S3) por default; "aws:kms" requiere además
  // S3_SSE_KMS_KEY_ID. Vacío lo desactiva (algunos S3-compatible no lo
  // soportan y rechazan el header).
  s3ServerSideEncryption: process.env.S3_SERVER_SIDE_ENCRYPTION ?? "AES256",
  s3SseKmsKeyId: process.env.S3_SSE_KMS_KEY_ID || "",
  // Retención de backups (platformBackupRetention.worker.ts). En 0
  // (default) el worker no borra NADA — mismo criterio que la retención de
  // auditoría: activar el borrado automático de backups es una decisión de
  // negocio, no algo que este código deba asumir solo.
  backupRetentionDiarioDias: readNumber(process.env.BACKUP_RETENTION_DIARIO_DIAS, 0),
  backupRetentionMensualMeses: readNumber(process.env.BACKUP_RETENTION_MENSUAL_MESES, 0),
  backupRetentionCheckIntervalMs: readNumber(
    process.env.BACKUP_RETENTION_CHECK_INTERVAL_MS,
    24 * 60 * 60_000
  ),
  // Clave de cifrado reversible para secretos de plataforma (hoy: el
  // client_secret OIDC de tenant_sso_config) — ver platformCrypto.ts.
  // Deliberadamente separada de JWT_SECRET: son cosas distintas (firmar vs
  // cifrar) y rotarlas por separado no debe invalidar todas las sesiones
  // activas. Base64 de 32 bytes: `openssl rand -base64 32`.
  appEncryptionKey: process.env.APP_ENCRYPTION_KEY || "",
  // SSO de Platform Admin (un solo proveedor global — el dueño del ERP es
  // una sola organización, a diferencia del SSO por tenant que sí necesita
  // guardarse en tenant_sso_config). Mismo criterio que
  // GOOGLE_LOGIN_CLIENT_ID: vive en env, no en la base — sin esto, el botón
  // de SSO simplemente no aparece en el panel (ver platformAdminSso.service.ts).
  platformSsoIssuerUrl: process.env.PLATFORM_SSO_ISSUER_URL || "",
  platformSsoClientId: process.env.PLATFORM_SSO_CLIENT_ID || "",
  platformSsoClientSecret: process.env.PLATFORM_SSO_CLIENT_SECRET || "",
};

// Si hay DATABASE_URL (Railway u otro proveedor gestionado), las variables
// PG_* individuales no son obligatorias — ver src/server/config/database.ts.
const pgVarsRequeridas = process.env.DATABASE_URL
  ? []
  : ["PG_HOST", "PG_USER", "PG_PASSWORD", "PG_DATABASE"];

export const requiredEnvNames = [
  "EMAIL_HOST",
  "EMAIL_PORT",
  "EMAIL_USER",
  "EMAIL_PASS",
  "RECAPTCHA_SITE_KEY",
  "RECAPTCHA_SECRET_KEY",
  ...pgVarsRequeridas,
  "JWT_SECRET",
];

export const missingRequiredEnv = requiredEnvNames.filter((name) => !process.env[name]);

export const emailConfigured = Boolean(
  env.emailHost &&
    env.emailPort &&
    env.emailUser &&
    env.emailPass &&
    env.contactDestination
);
