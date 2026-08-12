import { z } from "zod";

export const registrarLecturaCombustibleSchema = z.object({
  // Lo genera el dispositivo con crypto.randomUUID() al apretar "Registrar
  // lectura", online u offline (ver client/src/offline/). Opcional a
  // propósito: sin él, la creación se comporta igual que siempre. Con él,
  // un reintento del mismo envío no duplica (ver idempotentInsert.ts).
  cliente_uuid: z.string().uuid().optional(),
  combustible_id: z.number().int().positive(),
  nivel: z.number().nonnegative(),
  // Cuándo se TOMÓ la lectura, no cuándo llegó al servidor -- decide si
  // actualiza nivel_actual (ver combustible.repository.ts). Opcional:
  // sin dato, el service usa now() (siempre "la más reciente" en ese caso).
  leido_en: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type RegistrarLecturaCombustibleInput = z.infer<typeof registrarLecturaCombustibleSchema>;

// Wrapper legacy de PUT /:id/nivel -- mismo shape de body que siempre tuvo
// (nivel_actual), ahora validado con Zod como el resto de los módulos.
export const actualizarNivelCombustibleSchema = z.object({
  nivel_actual: z.number().nonnegative(),
});

export type ActualizarNivelCombustibleInput = z.infer<typeof actualizarNivelCombustibleSchema>;
