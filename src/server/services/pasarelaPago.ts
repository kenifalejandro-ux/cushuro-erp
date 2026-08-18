/** src/server/services/pasarelaPago.ts
 *
 * Adapter de pasarela de pago: aísla el resto del código (servicio de
 * dominio, webhook) de los detalles de Culqi. `platformBilling.service.ts`
 * y `routes/webhooksPasarela.ts` solo conocen esta interface, nunca
 * `pasarelaPagoCulqi.ts` directo — así el Stub es un reemplazo total en
 * desarrollo/tests, no un mock parcial.
 *
 * `obtenerPasarelaPago()` decide cuál usar según haya o no
 * `CULQI_SECRET_KEY` configurada -- mismo criterio de "modo degradado sin
 * config" que ya usa el proyecto con Redis (getRedis() devuelve null si
 * no hay REDIS_URL/REDIS_HOST). Sin esto, correr local sin plata real
 * exigiría acordarse de un flag aparte.
 */
import { env } from "../config/env";
import { StubPasarela } from "./pasarelaPagoStub";
import { CulqiPasarela } from "./pasarelaPagoCulqi";

export type Moneda = "USD" | "PEN";

export interface CargoResultado {
  idPasarela: string;
  estado: "exitoso" | "fallido";
  motivoFallo?: string;
}

export interface DatosCargo {
  tokenPasarela?: string;
  monto: number;
  moneda: Moneda;
  descripcion: string;
}

export interface EventoWebhookVerificado {
  eventoId: string;
  tipo: string;
  payload: unknown;
}

export interface PasarelaPago {
  nombre: "culqi" | "stub";

  /** `tokenPasarela` ausente = cobro por transferencia (no hay tarjeta
   *  involucrada, este método no debería llamarse en ese caso -- lo
   *  resuelve platformBilling.service.ts antes de llegar acá). */
  crearCargo(datos: DatosCargo): Promise<CargoResultado>;

  /** `null` = firma inválida o pasarela no reconocida -- la ruta responde
   *  400 sin persistir nada en webhooks_pasarela. */
  verificarWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>
  ): EventoWebhookVerificado | null;
}

let instancia: PasarelaPago | null = null;

export function obtenerPasarelaPago(): PasarelaPago {
  if (!instancia) {
    instancia = env.culqiSecretKey ? new CulqiPasarela() : new StubPasarela();
  }
  return instancia;
}

/** Solo para tests: fuerza qué implementación devuelve obtenerPasarelaPago()
 *  en lo que resta del proceso, sin depender de variables de entorno. */
export function fijarPasarelaPagoParaTests(pasarela: PasarelaPago | null): void {
  instancia = pasarela;
}
