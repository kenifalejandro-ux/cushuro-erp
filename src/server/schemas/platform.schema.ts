import { z } from "zod";
import { MODULOS_ERP as MODULOS_ERP_REGISTRY } from "../../modules/registry";

export const crearTenantSchema = z.object({
  tenantNombre: z.string().trim().min(1, "Nombre de tenant requerido").max(200),
  tenantSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "El slug solo admite minúsculas, números y guiones"),
  adminNombre: z.string().trim().min(1, "Nombre del admin requerido").max(100),
  adminEmail: z.string().trim().toLowerCase().email("Correo inválido").max(150),
  adminPassword: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
});

export type CrearTenantInput = z.infer<typeof crearTenantSchema>;

// Onboarding completo (POST /api/platform/tenants/onboard, gateado a
// super-admin): mismos campos que crearTenantSchema + un plan opcional.
// planCodigo separado de tenantOnboardingService.ts porque acá se valida
// SOLO la forma del dato (string no vacío); si el código corresponde a un
// plan que existe y está activo es responsabilidad del service, no del
// schema.
export const onboardTenantSchema = crearTenantSchema.extend({
  planCodigo: z.string().trim().min(1).max(50).optional(),
});

export type OnboardTenantInput = z.infer<typeof onboardTenantSchema>;

export const cambiarEstadoTenantSchema = z.object({
  activo: z.boolean(),
  motivo: z.string().trim().max(500).optional(),
});

export type CambiarEstadoTenantInput = z.infer<typeof cambiarEstadoTenantSchema>;

// Derivado de src/modules/registry.ts — la fuente única de qué módulos
// existen (ver docs/adr/0002-contrato-de-modulo.md). El cast solo satisface
// la forma que z.enum() exige (tupla no vacía); tests/module-registry.test.ts
// verifica que este set siga coincidiendo con el enum modulo_erp de Postgres.
export const MODULOS_ERP = MODULOS_ERP_REGISTRY as [string, ...string[]];

// Para /tenants/:tenantId/usuarios/:usuarioId/modulos — asignación cruda,
// sin estado propio (ver usuario_modulos, sigue siendo solo presencia).
export const actualizarModulosSchema = z.object({
  modulos: z.array(z.enum(MODULOS_ERP)),
});

export type ActualizarModulosInput = z.infer<typeof actualizarModulosSchema>;

// Para /tenants/:id/modulos — configuración granular por módulo (ver
// migrations/0021_tenant_modulos_granular.sql). rolloutPorcentaje solo se
// exige junto con estado "rollout" (refine abajo); en cualquier otro
// estado, si viene, se ignora en la lectura (obtenerModulosPermitidos)
// pero no rompe la validación — más simple no prohibirlo que tener que
// explicar por qué un campo "extra" hace fallar el request.
export const configuracionModuloSchema = z
  .object({
    modulo: z.enum(MODULOS_ERP),
    estado: z.enum(["habilitado", "deshabilitado", "rollout"]),
    rolloutPorcentaje: z.number().int().min(0).max(100).nullable().optional(),
    version: z.string().trim().max(20).nullable().optional(),
  })
  .refine((c) => c.estado !== "rollout" || typeof c.rolloutPorcentaje === "number", {
    message: "rolloutPorcentaje es requerido cuando el estado es 'rollout'",
    path: ["rolloutPorcentaje"],
  });

export const actualizarModulosTenantSchema = z.object({
  configuraciones: z.array(configuracionModuloSchema),
});

export type ActualizarModulosTenantInput = z.infer<typeof actualizarModulosTenantSchema>;

// Para PUT /modulos/:modulo/global — mismo shape que un ítem de
// configuraciones, pero el módulo va en la URL, no en el body.
export const actualizarModuloGlobalSchema = z
  .object({
    estado: z.enum(["habilitado", "deshabilitado", "rollout"]),
    rolloutPorcentaje: z.number().int().min(0).max(100).nullable().optional(),
    version: z.string().trim().max(20).nullable().optional(),
  })
  .refine((c) => c.estado !== "rollout" || typeof c.rolloutPorcentaje === "number", {
    message: "rolloutPorcentaje es requerido cuando el estado es 'rollout'",
    path: ["rolloutPorcentaje"],
  });

export type ActualizarModuloGlobalInput = z.infer<typeof actualizarModuloGlobalSchema>;

export const crearUsuarioEnTenantSchema = z.object({
  nombre: z.string().trim().min(1, "Nombre requerido").max(100),
  email: z.string().trim().toLowerCase().email("Correo inválido").max(150),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
  rol: z.enum(["admin", "operador", "lectura"]).optional(),
});

export type CrearUsuarioEnTenantInput = z.infer<typeof crearUsuarioEnTenantSchema>;

export const cambiarEstadoUsuarioSchema = z.object({
  activo: z.boolean(),
  motivo: z.string().trim().max(500).optional(),
});

export type CambiarEstadoUsuarioInput = z.infer<typeof cambiarEstadoUsuarioSchema>;

// null = quitarle el dominio propio al tenant (vuelve a depender del
// subdominio de la plataforma o del campo manual).
export const actualizarDominioSchema = z.object({
  dominioPersonalizado: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(255)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Dominio inválido")
    .nullable(),
});

export type ActualizarDominioInput = z.infer<typeof actualizarDominioSchema>;

export const platformSesionSchema = z.object({
  token: z.string().min(1, "Token requerido"),
});

export type PlatformSesionInput = z.infer<typeof platformSesionSchema>;

export const platformAdminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Correo inválido").max(150),
  password: z.string().min(1, "Contraseña requerida").max(200),
});

export type PlatformAdminLoginInput = z.infer<typeof platformAdminLoginSchema>;

export const crearPlatformAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email("Correo inválido").max(150),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
  nombre: z.string().trim().min(1, "Nombre requerido").max(100),
  rol: z.enum(["super_admin", "admin"]).default("admin"),
});

export type CrearPlatformAdminInput = z.infer<typeof crearPlatformAdminSchema>;

export const cambiarEstadoPlatformAdminSchema = z.object({
  activo: z.boolean(),
  motivo: z.string().trim().max(500).optional(),
});

export type CambiarEstadoPlatformAdminInput = z.infer<typeof cambiarEstadoPlatformAdminSchema>;

// confirmar: true es obligatorio a propósito (no un boolean cualquiera) —
// restaurar vacía primero los datos actuales del tenant destino, no hay
// vuelta atrás. Un body sin ese campo (ej. un cliente viejo, o un test
// que se olvidó) nunca pasa la validación por accidente.
export const restaurarBackupSchema = z.object({
  targetTenantId: z.string().uuid("targetTenantId debe ser un UUID válido"),
  confirmar: z.literal(true, { message: "Hay que mandar confirmar: true para restaurar" }),
});

export type RestaurarBackupInput = z.infer<typeof restaurarBackupSchema>;

// Restaurar un backup de plataforma es aditivo (nunca borra, ver
// restaurarBackupPlataformaService) — pero igual exige confirmar:true,
// mismo criterio que el restore de tenant: reinsertar tenants/admins que
// alguien borró a propósito tiene que ser una decisión explícita. No lleva
// targetTenantId porque no aplica a ningún tenant en particular.
export const restaurarBackupPlataformaSchema = z.object({
  confirmar: z.literal(true, { message: "Hay que mandar confirmar: true para restaurar" }),
});

export type RestaurarBackupPlataformaInput = z.infer<typeof restaurarBackupPlataformaSchema>;

// SSO por tenant (ver tenant_sso_config, migrations/0026). clientSecret es
// obligatorio en cada guardado a propósito — ver el comentario en
// configurarSsoTenantService (tenantSso.service.ts) sobre por qué no hay
// un flujo de "dejar en blanco para no cambiarlo".
export const configurarSsoTenantSchema = z.object({
  issuerUrl: z.string().trim().url("issuerUrl debe ser una URL válida").max(500),
  clientId: z.string().trim().min(1, "clientId requerido").max(300),
  clientSecret: z.string().trim().min(1, "clientSecret requerido").max(2000),
  dominioEmailPermitido: z.string().trim().toLowerCase().max(255).nullable().optional(),
  activo: z.boolean(),
});

export type ConfigurarSsoTenantInput = z.infer<typeof configurarSsoTenantSchema>;

// Cuotas por tenant (ver tenant_cuotas, migración 0033). Los tres estados
// posibles se expresan así en el body:
//   { limite: 500 }   → ese tenant tiene 500
//   { limite: null }  → ese tenant es ILIMITADO (override explícito)
//   omitir `limite`   → borra el override y vuelve al default del código
// Por eso `limite` es .optional().nullable() y no un simple number: los tres
// casos tienen que poder distinguirse, y "sin límite" no es lo mismo que
// "sin override".
export const fijarCuotaTenantSchema = z.object({
  recurso: z.string().trim().min(1, "Recurso requerido").max(60),
  limite: z.number().int().min(0).nullable().optional(),
  motivo: z.string().trim().max(500).optional(),
});

export type FijarCuotaTenantInput = z.infer<typeof fijarCuotaTenantSchema>;

// Asignar plan a un tenant (ver planes, migración 0034). Acepta el `codigo`
// del plan ("mype", "pequena", ...) o su UUID; `null` desasigna y devuelve
// al tenant a los defaults del registry.
export const asignarPlanTenantSchema = z.object({
  plan: z.string().trim().min(1).max(80).nullable(),
  motivo: z.string().trim().max(500).optional(),
});

export type AsignarPlanTenantInput = z.infer<typeof asignarPlanTenantSchema>;
