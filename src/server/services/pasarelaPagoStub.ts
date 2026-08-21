/** src/server/services/pasarelaPagoStub.ts
 *
 * Implementación de PasarelaPago para desarrollo local y tests: nunca
 * llama a nada externo. Se activa automáticamente cuando no hay
 * CULQI_SECRET_KEY configurada (ver pasarelaPago.ts).
 *
 * `crearCargo` es determinístico por monto para poder probar el camino de
 * fallo sin depender de azar: un monto que termina en .13 (MONTO_MAGICO_FALLO)
 * simula un cargo rechazado, cualquier otro monto es exitoso.
 */
import { randomUUID } from "crypto";
import type {
  CargoResultado,
  DatosCargo,
  EventoWebhookVerificado,
  PasarelaPago,
} from "./pasarelaPago";

const MONTO_MAGICO_FALLO = 0.13;

/** Firma de juguete para simular webhooks en tests: un JSON con
 *  `secretoStub` en texto plano. Nunca usar esto contra tráfico real --
 *  la Stub solo corre quien controla el proceso local/de test. */
const SECRETO_STUB = "stub-no-es-secreto-real";

export class StubPasarela implements PasarelaPago {
  readonly nombre = "stub" as const;

  async crearCargo(datos: DatosCargo): Promise<CargoResultado> {
    const idPasarela = `stub_cargo_${randomUUID()}`;
    if (Math.round((datos.monto % 1) * 100) === MONTO_MAGICO_FALLO * 100) {
      return { idPasarela, estado: "fallido", motivoFallo: "Rechazado por el emisor (simulado)" };
    }
    return { idPasarela, estado: "exitoso" };
  }

  verificarWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>
  ): EventoWebhookVerificado | null {
    const firma = headers["x-stub-signature"];
    if (firma !== SECRETO_STUB) return null;

    let body: { eventoId?: string; tipo?: string; payload?: unknown };
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return null;
    }
    if (!body.eventoId || !body.tipo) return null;

    return { eventoId: body.eventoId, tipo: body.tipo, payload: body.payload ?? body };
  }
}
