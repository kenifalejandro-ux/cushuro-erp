/** src/server/routes/webhooksPasarela.ts
 *
 * Webhook de la pasarela de pago (Culqi u otra futura) -- PÚBLICO a
 * propósito, sin platformAdminMiddleware: la pasarela llama a esta ruta
 * directo, no hay sesión de plataforma de por medio. Se autentica con la
 * verificación de firma de PasarelaPago.verificarWebhook(), no con un
 * middleware de auth genérico.
 *
 * Montado en app.ts fuera de /api/platform, transversal como
 * /api/facturacion (ver facturacion.ts).
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { asyncHandler } from "../shared/utils/asyncHandler";
import { getClientIp } from "../shared/utils/request";
import { logger } from "../config/logger";
import { pool } from "../config/database";
import { obtenerPasarelaPago } from "../services/pasarelaPago";
import { aplicarEventoWebhookService } from "../services/platformBilling.service";

export const webhooksPasarelaRouter = Router();

webhooksPasarelaRouter.post(
  "/culqi",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const pasarela = obtenerPasarelaPago();
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from("");
    const evento = pasarela.verificarWebhook(
      rawBody,
      req.headers as Record<string, string | string[] | undefined>
    );

    if (!evento) {
      logger.warn(
        { pasarela: pasarela.nombre },
        "Webhook de pasarela con firma inválida, rechazado"
      );
      return res.status(400).json({ ok: false, message: "Firma inválida" });
    }

    // ON CONFLICT DO NOTHING es lo que hace la idempotencia real: si la
    // pasarela reintenta el mismo evento_id (no respondimos 200 a tiempo
    // la vez anterior, por ejemplo), este INSERT no vuelve fila y NO se
    // reaplica el efecto -- solo se persiste la primera vez.
    const insertado = await pool.query(
      `INSERT INTO webhooks_pasarela (pasarela, evento_id, tipo, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (pasarela, evento_id) DO NOTHING
       RETURNING id`,
      [pasarela.nombre, evento.eventoId, evento.tipo, JSON.stringify(evento.payload)]
    );

    if (insertado.rows.length === 0) {
      return res.status(200).json({ ok: true, duplicado: true });
    }

    const webhookId = insertado.rows[0].id;
    try {
      await aplicarEventoWebhookService(evento, {
        ip: getClientIp(req),
        actorType: "system",
        actorLabel: `webhook-${pasarela.nombre}`,
      });
      await pool.query(`UPDATE webhooks_pasarela SET procesado_en = now() WHERE id = $1`, [
        webhookId,
      ]);
    } catch (err) {
      // No se relanza: la pasarela reintentaría indefinidamente un evento
      // que ya quedó registrado (evita reprocesarlo por el ON CONFLICT de
      // arriba, así que un 5xx acá solo generaría reintentos inútiles).
      // El registro sin procesar queda en webhooks_pasarela para diagnóstico.
      logger.error(
        { err, webhookId, tipo: evento.tipo },
        "Falló aplicar el efecto de un webhook de pasarela"
      );
    }

    res.status(200).json({ ok: true });
  })
);
