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
};

// Si hay DATABASE_URL (Railway), las variables PG_* no son obligatorias
const pgVarsRequired = !process.env.DATABASE_URL
  ? ["PG_HOST", "PG_USER", "PG_PASSWORD", "PG_DATABASE"]
  : [];

export const requiredEnvNames = [
  "EMAIL_HOST",
  "EMAIL_PORT",
  "EMAIL_USER",
  "EMAIL_PASS",
  "RECAPTCHA_SITE_KEY",
  "RECAPTCHA_SECRET_KEY",
  ...pgVarsRequired,
];

export const missingRequiredEnv = requiredEnvNames.filter((name) => !process.env[name]);

export const emailConfigured = Boolean(
  env.emailHost &&
    env.emailPort &&
    env.emailUser &&
    env.emailPass &&
    env.contactDestination
);
