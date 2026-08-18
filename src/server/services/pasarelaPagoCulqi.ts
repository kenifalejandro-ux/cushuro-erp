/** src/server/services/pasarelaPagoCulqi.ts
 *
 * Implementación real de PasarelaPago contra la API de Culqi (v2). Solo se
 * instancia cuando hay CULQI_SECRET_KEY configurada (ver pasarelaPago.ts) --
 * sin eso, el proceso corre con StubPasarela y esta clase nunca se toca.
 *
 * IMPORTANTE al activar claves reales: el shape exacto de /v2/charges y la
 * verificación de webhooks acá abajo son la mejor aproximación disponible
 * al escribir esto, pero Culqi puede haber cambiado su contrato -- revalidar
 * contra la documentación vigente en el primer cargo/webhook real antes de
 * confiar en producción. El punto de la interface PasarelaPago es que ese
 * ajuste queda aislado a este archivo, sin tocar platformBilling.service.ts
 * ni la ruta del webhook.
 *
 * Culqi no firma sus webhooks con HMAC (a diferencia de Stripe) -- la
 * mitigación que documentan es un secreto compartido en la URL o un header
 * propio. Acá se exige el header `X-Culqi-Webhook-Secret` con
 * CULQI_WEBHOOK_SECRET; si Culqi habilita firma criptográfica real más
 * adelante, el cambio queda contenido en verificarWebhook().
 */
import { env } from "../config/env";
import { AppError } from "../shared/middlewares/error.middleware";
import { logger } from "../config/logger";
import type {
  CargoResultado,
  DatosCargo,
  EventoWebhookVerificado,
  PasarelaPago,
} from "./pasarelaPago";

const CULQI_API_BASE = "https://api.culqi.com/v2";

export class CulqiPasarela implements PasarelaPago {
  readonly nombre = "culqi" as const;

  async crearCargo(datos: DatosCargo): Promise<CargoResultado> {
    if (!datos.tokenPasarela) {
      throw new AppError(400, "Falta el token de la tarjeta para cobrar por Culqi");
    }

    const res = await fetch(`${CULQI_API_BASE}/charges`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.culqiSecretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Culqi espera el monto en la unidad menor de la moneda (centavos).
        amount: Math.round(datos.monto * 100),
        currency_code: datos.moneda,
        source_id: datos.tokenPasarela,
        description: datos.descripcion,
      }),
    });

    const cuerpo = await res.json().catch(() => ({}));

    if (!res.ok) {
      logger.warn({ status: res.status, cuerpo }, "Culqi rechazó el cargo");
      return {
        idPasarela: cuerpo.id ?? cuerpo.charge_id ?? "sin_id",
        estado: "fallido",
        motivoFallo: cuerpo.user_message || cuerpo.merchant_message || `HTTP ${res.status}`,
      };
    }

    return { idPasarela: cuerpo.id, estado: "exitoso" };
  }

  verificarWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>
  ): EventoWebhookVerificado | null {
    const secretoRecibido = headers["x-culqi-webhook-secret"];
    if (!env.culqiWebhookSecret || secretoRecibido !== env.culqiWebhookSecret) {
      return null;
    }

    let body: { id?: string; type?: string; data?: unknown };
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return null;
    }
    if (!body.id || !body.type) return null;

    return { eventoId: body.id, tipo: body.type, payload: body.data ?? body };
  }
}
