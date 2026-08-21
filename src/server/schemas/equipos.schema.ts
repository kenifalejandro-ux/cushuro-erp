import { z } from "zod";

export const crearEquipoSchema = z.object({
  // Lo genera el dispositivo con crypto.randomUUID() al apretar "Registrar
  // Equipo", online u offline (ver client/src/offline/). Opcional a
  // propósito: sin él, la creación se comporta exactamente como siempre —
  // ningún cliente viejo se rompe. Con él, un reintento del mismo envío no
  // duplica (ver idempotentInsert.ts).
  cliente_uuid: z.string().uuid().optional(),
  placa_codigo: z.string().trim().min(1, "Placa/código requerido").max(50),
  tipo: z.string().trim().min(1, "Tipo requerido").max(100),
  marca: z.string().trim().max(100).optional(),
  modelo: z.string().trim().max(100).optional(),
});

export type CrearEquipoInput = z.infer<typeof crearEquipoSchema>;

export const actualizarEquipoSchema = z.object({
  placa_codigo: z.string().trim().min(1, "Placa/código requerido").max(50),
  tipo: z.string().trim().min(1, "Tipo requerido").max(100),
  marca: z.string().trim().max(100).optional(),
  modelo: z.string().trim().max(100).optional(),
});

export type ActualizarEquipoInput = z.infer<typeof actualizarEquipoSchema>;
