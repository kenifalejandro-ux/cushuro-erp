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

/** Se despachó más de lo que el tanque de esa unidad puede contener
 *  (migraciones 0069/0070). El vale NO se bloqueó: la explicación más
 *  probable no es fraude (un bidón extra en el mismo vale, o la capacidad
 *  mal cargada), pero necesita que alguien lo confirme. */
export async function enviarCorreoAlertaSobredespacho(
  destinatarios: Destinatario[],
  params: {
    serieTalonario: string;
    nVale: number;
    cantidad: number;
    unidadDespacho: string;
    capacidad: number;
    unidadCapacidad: string;
    excesoPct: number;
  }
) {
  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: sobredespacho en vale ${params.serieTalonario}-${String(params.nVale).padStart(5, "0")}`,
    titulo: `Sobredespacho detectado en la serie ${params.serieTalonario}`,
    lineas: [
      `El vale ${String(params.nVale).padStart(5, "0")} despachó ${params.cantidad} ` +
        `${params.unidadDespacho} a una unidad cuyo tanque es de ${params.capacidad} ` +
        `${params.unidadCapacidad} -- un ${params.excesoPct}% por encima de su capacidad.`,
      "El vale se registró igual (no se bloquea el abastecimiento). Puede ser un bidón " +
        "cargado en el mismo vale, la capacidad mal cargada en el sistema, o un error de " +
        "tipeo -- revisar en el ERP.",
    ],
  });
}

/** El horómetro/odómetro no cierra con el del despacho anterior de esa
 *  misma unidad (punto 5 del documento). El vale NO se bloqueó: puede ser
 *  un tipeo, pero también adulteración -- por eso lo mira una persona. */
export async function enviarCorreoAlertaMedidor(
  destinatarios: Destinatario[],
  params: {
    serieTalonario: string;
    nVale: number;
    medidor: "horometro" | "odometro";
    motivo: "retroceso" | "excede_calendario";
    valorAnterior: number;
    valorNuevo: number;
    horasDeclaradas?: number;
    horasCalendario?: number;
  }
) {
  const nombreMedidor = params.medidor === "horometro" ? "horómetro" : "odómetro";
  const vale = String(params.nVale).padStart(5, "0");

  const explicacion =
    params.motivo === "retroceso"
      ? `El ${nombreMedidor} marcó ${params.valorNuevo}, MENOS que los ${params.valorAnterior} ` +
        `del despacho anterior de esa unidad. Un medidor no vuelve atrás.`
      : `El horómetro sumó ${params.horasDeclaradas} horas de motor, pero desde el despacho ` +
        `anterior solo pasaron ${params.horasCalendario} horas de reloj. Una máquina no puede ` +
        `acumular más horas de motor que las que pasaron.`;

  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: ${nombreMedidor} inconsistente en vale ${params.serieTalonario}-${vale}`,
    titulo: `Medidor inconsistente en la serie ${params.serieTalonario}`,
    lineas: [
      `Vale ${vale}. ${explicacion}`,
      "El vale se registró igual (no se bloquea el abastecimiento). Puede ser un error de " +
        "tipeo o un medidor adulterado -- revisar en el ERP.",
    ],
  });
}

/** El tanque cruzó su nivel mínimo. A diferencia del resto, esta alerta NO
 *  es anti-fraude sino operativa: avisa antes de quedarse sin combustible
 *  en cancha. Por eso tampoco se congela como anomalía. */
export async function enviarCorreoAlertaNivelBajo(
  destinatarios: Destinatario[],
  params: { tanqueNombre: string; nivel: number; nivelMinimo: number; unidad: string }
) {
  await enviarCorreoAlerta({
    destinatarios,
    asunto: `Combustible: nivel bajo en ${params.tanqueNombre}`,
    titulo: `Nivel bajo en ${params.tanqueNombre}`,
    lineas: [
      `La última lectura de varilla marcó ${params.nivel} ${params.unidad}, por debajo del ` +
        `mínimo configurado de ${params.nivelMinimo} ${params.unidad}.`,
      "Conviene programar la reposición antes de que la operación se quede sin combustible.",
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
