import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Correo inválido").max(150),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
});

export type LoginInput = z.infer<typeof loginSchema>;
