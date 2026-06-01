import nodemailer from "nodemailer";
import { emailConfigured, env } from "./env";
import { logger } from "./logger";

export const transporter = emailConfigured
  ? nodemailer.createTransport({
      host: env.emailHost,
      port: env.emailPort,
      secure: env.emailPort === 465,
      pool: true,
      maxConnections: env.emailMaxConnections,
      maxMessages: env.emailMaxMessages,
      requireTLS: true,
      auth: {
        user: env.emailUser,
        pass: env.emailPass,
      },
      tls: {
        minVersion: "TLSv1.2",
      },
    })
  : null;

export async function verifyMailer() {
  if (!transporter) return;

  try {
    await transporter.verify();
    logger.info("SMTP verificado y listo para enviar formularios");
  } catch (error) {
    logger.error({ err: error }, "No se pudo verificar el transporte SMTP");
  }
}
