/** src/modules/combustible/combustibleAlertas.mailer.ts
 *
 * Correo de las alertas de combustible (migrations/0068): mismo transporter
 * y mismo contrato "nunca lanza" que enviarCorreoRecuperacion() en
 * auth.service.ts -- un fallo de SMTP no puede tumbar la mutación que lo
 * originó (crear un despacho, anular un vale), solo se loguea.
 */
import { emailConfigured, env } from "../../server/config/env";
import { transporter } from "../../server/config/mailer";
import { logger } from "../../server/config/logger";
import { escapeHtml } from "../../server/shared/utils/html";

interface Destinatario {
  email: string;
  nombre: string;
}

async function enviarCorreoAlerta(params: {
  destinatarios: Destinatario[];
  asunto: string;
  titulo: string;
  lineas: string[];
}) {
  if (!transporter || !emailConfigured || params.destinatarios.length === 0) return;

  const text = [params.titulo, "", ...params.lineas].join("\n");
  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin-bottom: 16px;">${escapeHtml(params.titulo)}</h2>
      ${params.lineas.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n")}
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"MinCore ERP" <${env.emailUser}>`,
      to: params.destinatarios.map((d) => d.email),
      subject: params.asunto,
      text,
      html,
    });
  } catch (err) {
    logger.error({ err }, "No se pudo enviar el correo de alerta de combustible");
  }
}

/** Un vale más allá reveló que uno o más números anteriores nunca se
 *  registraron (ver detectarHuecosRevelados en combustible.repository.ts).
 *  Todavía no se sabe la causa -- puede resolverse solo en unas horas
 *  (offline que sincroniza) o quedar como hallazgo real al cerrar el
 *  período (Fase D entrega 2). */
export async function enviarCorreoAlertaHueco(
  destinatarios: Destinatario[],
  params: { serieTalonario: string; valesFaltantes: number[]; nValeQueLoRevelo: number }
) {
  const listaVales = params.valesFaltantes.map((n) => String(n).padStart(5, "0")).join(", ");
  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: hueco en talonario ${params.serieTalonario}`,
    titulo: `Hueco detectado en la serie ${params.serieTalonario}`,
    lineas: [
      `Falta${params.valesFaltantes.length > 1 ? "n" : ""} el vale ${listaVales} -- se detectó` +
        ` al registrarse el vale ${String(params.nValeQueLoRevelo).padStart(5, "0")}.`,
      "Puede resolverse solo (por ejemplo si el vale está pendiente de sincronizar sin señal) " +
        "o seguir sin explicación -- revisar en el ERP.",
    ],
  });
}

/** Un vale que sí se había registrado se anuló -- a diferencia del hueco,
 *  esto siempre tiene un motivo escrito por quien lo anuló, pero necesita
 *  revisión: "todo tiene que tener sustento". */
export async function enviarCorreoAlertaAnulacion(
  destinatarios: Destinatario[],
  params: { serieTalonario: string; nVale: number; motivo: string }
) {
  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: vale anulado en talonario ${params.serieTalonario}`,
    titulo: `Vale anulado en la serie ${params.serieTalonario}`,
    lineas: [
      `El vale ${String(params.nVale).padStart(5, "0")} fue anulado. Motivo: "${params.motivo}".`,
      "Revisar en el ERP y marcarlo como revisado si el motivo es válido.",
    ],
  });
}
