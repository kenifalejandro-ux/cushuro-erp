import { z } from "zod";

// Repuestos no tiene schema de validación para create/update/bulk (ver el
// comentario en repuestos.repository.ts) -- ese gap es preexistente y queda
// fuera de este cambio. Este schema es SOLO para el endpoint nuevo de
// movimientos.
export const registrarMovimientoRepuestoSchema = z.object({
  // Lo genera el dispositivo con crypto.randomUUID() al abrir el modal,
  // online u offline (ver client/src/offline/). Opcional a propósito: sin
  // él, la creación se comporta igual que siempre. Con él, un reintento del
  // mismo envío no duplica (ver idempotentInsert.ts).
  cliente_uuid: z.string().uuid().optional(),
  repuesto_id: z.number().int().positive(),
  tipo: z.enum(["entrada", "salida"]),
  cantidad: z.number().int().positive(),
  motivo: z.string().max(200).optional(),
  // Cuándo pasó el movimiento, no cuándo llegó al servidor -- solo para el
  // historial (ver migrations/0046_repuestos_movimientos.sql, a diferencia
  // de Combustible NO decide si el stock se actualiza). Opcional: sin dato,
  // el service usa now().
  registrado_en: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type RegistrarMovimientoRepuestoInput = z.infer<typeof registrarMovimientoRepuestoSchema>;
