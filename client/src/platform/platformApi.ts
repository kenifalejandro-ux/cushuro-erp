// client/src/platform/platformApi.ts
//
// Wrapper de fetch propio a propósito — NO reusa apiFetch de
// ../services/apiClient.ts, que asume el ciclo de cookie+refresh de un
// tenant (401 → POST /api/auth/refresh → onSesionExpirada de
// AuthContext). Acá la sesión es la cookie httpOnly `platform_session`
// (ver POST /sesion), sin refresh ni rotación — un 401 simplemente
// significa "no autenticado", sin reintento automático.

const BASE = "/api/platform";

async function parseOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Error HTTP ${res.status}`);
  }
  return data;
}

function platformFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, { credentials: "include", ...init });
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export async function iniciarSesionPlataformaApi(token: string): Promise<void> {
  const res = await platformFetch("/sesion", jsonInit("POST", { token }));
  await parseOrThrow(res);
}

export async function iniciarSesionAdminApi(email: string, password: string): Promise<void> {
  const res = await platformFetch("/admin-sesion", jsonInit("POST", { email, password }));
  await parseOrThrow(res);
}

export async function cerrarSesionPlataformaApi(): Promise<void> {
  await platformFetch("/sesion/salir", { method: "POST" });
}

export interface QuienSoy {
  actorType: "platform_admin" | "emergency_shared_secret" | "unauthenticated";
  actorLabel: string | null;
  esSuperAdmin: boolean;
}

export async function whoamiApi(): Promise<QuienSoy> {
  const res = await platformFetch("/whoami");
  const data = await parseOrThrow(res);
  return {
    actorType: data.actorType,
    actorLabel: data.actorLabel,
    esSuperAdmin: data.esSuperAdmin,
  };
}

export interface PlatformAdmin {
  id: string;
  email: string;
  nombre: string;
  rol: "super_admin" | "admin";
  activo: boolean;
  creadoEn: string;
}

export async function listarPlatformAdminsApi(): Promise<PlatformAdmin[]> {
  const res = await platformFetch("/admins");
  const data = await parseOrThrow(res);
  return data.admins;
}

export async function crearPlatformAdminApi(input: {
  email: string;
  password: string;
  nombre: string;
  rol: "super_admin" | "admin";
}): Promise<void> {
  const res = await platformFetch("/admins", jsonInit("POST", input));
  await parseOrThrow(res);
}

export async function cambiarEstadoPlatformAdminApi(
  id: string,
  activo: boolean,
  motivo?: string
): Promise<void> {
  const res = await platformFetch(`/admins/${id}/estado`, jsonInit("PATCH", { activo, motivo }));
  await parseOrThrow(res);
}

export interface SesionActivaAdmin {
  sessionId: string;
  ip: string;
  creadaEn: string;
}

export async function listarSesionesDeAdminApi(adminId: string): Promise<SesionActivaAdmin[]> {
  const res = await platformFetch(`/admins/${adminId}/sesiones`);
  const data = await parseOrThrow(res);
  return data.sesiones;
}

export async function revocarSesionPlataformaApi(sessionId: string): Promise<boolean> {
  const res = await platformFetch(`/sesiones/${sessionId}/revocar`, { method: "POST" });
  const data = await parseOrThrow(res);
  return data.revocada;
}

export type EstadoDominio = "pendiente_verificacion" | "activo" | "fallido" | "desactivado";

export interface TenantPlataforma {
  id: string;
  nombre: string;
  slug: string;
  activo: boolean;
  dominioPersonalizado: string | null;
  dominioEstado: EstadoDominio;
}

export interface DominioTenant {
  dominioPersonalizado: string | null;
  dominioEstado: EstadoDominio;
  dominioRegistroEsperado: string | null;
  dominioValorEsperado: string | null;
  dominioVerificadoEn: string | null;
  dominioVerificacionIntentos: number;
  dominioUltimoIntentoEn: string | null;
}

export async function listarTenantsApi(): Promise<TenantPlataforma[]> {
  const res = await platformFetch("/tenants");
  const data = await parseOrThrow(res);
  return data.tenants;
}

export async function crearTenantApi(
  input: {
    tenantNombre: string;
    tenantSlug: string;
    adminNombre: string;
    adminEmail: string;
    adminPassword: string;
  },
  idempotencyKey?: string
): Promise<void> {
  const init = jsonInit("POST", input);
  if (idempotencyKey) init.headers = { ...init.headers, "Idempotency-Key": idempotencyKey };
  const res = await platformFetch("/tenants", init);
  await parseOrThrow(res);
}

export async function cambiarEstadoTenantApi(
  tenantId: string,
  activo: boolean,
  motivo?: string
): Promise<void> {
  const res = await platformFetch(
    `/tenants/${tenantId}/estado`,
    jsonInit("PATCH", { activo, motivo })
  );
  await parseOrThrow(res);
}

export async function obtenerDominioTenantApi(tenantId: string): Promise<DominioTenant> {
  const res = await platformFetch(`/tenants/${tenantId}/dominio`);
  const data = await parseOrThrow(res);
  return data.dominio;
}

export async function actualizarDominioTenantApi(
  tenantId: string,
  dominioPersonalizado: string | null
): Promise<DominioTenant> {
  const res = await platformFetch(
    `/tenants/${tenantId}/dominio`,
    jsonInit("PATCH", { dominioPersonalizado })
  );
  const data = await parseOrThrow(res);
  return data.dominio;
}

export async function verificarDominioTenantApi(tenantId: string): Promise<DominioTenant> {
  const res = await platformFetch(`/tenants/${tenantId}/dominio/verificar`, { method: "POST" });
  const data = await parseOrThrow(res);
  return data.dominio;
}

export type EstadoModulo = "habilitado" | "deshabilitado" | "rollout";

export interface ModuloEstado {
  modulo: string;
  estado: EstadoModulo;
  rolloutPorcentaje: number | null;
  version: string | null;
}

export interface ConfiguracionModulo {
  modulo: string;
  estado: EstadoModulo;
  rolloutPorcentaje?: number | null;
  version?: string | null;
}

export async function obtenerModulosTenantApi(tenantId: string): Promise<ModuloEstado[]> {
  const res = await platformFetch(`/tenants/${tenantId}/modulos`);
  const data = await parseOrThrow(res);
  return data.modulos;
}

export async function actualizarModulosTenantApi(
  tenantId: string,
  configuraciones: ConfiguracionModulo[]
): Promise<ModuloEstado[]> {
  const res = await platformFetch(
    `/tenants/${tenantId}/modulos`,
    jsonInit("PUT", { configuraciones })
  );
  const data = await parseOrThrow(res);
  return data.modulos;
}

export async function actualizarModuloGlobalApi(
  modulo: string,
  config: { estado: EstadoModulo; rolloutPorcentaje?: number | null; version?: string | null }
): Promise<number> {
  const res = await platformFetch(`/modulos/${modulo}/global`, jsonInit("PUT", config));
  const data = await parseOrThrow(res);
  return data.tenantsAfectados;
}

export interface UsuarioPlataforma {
  id: string;
  nombre: string;
  email: string;
  rol: string;
  activo: boolean;
}

export async function listarUsuariosTenantApi(tenantId: string): Promise<UsuarioPlataforma[]> {
  const res = await platformFetch(`/tenants/${tenantId}/usuarios`);
  const data = await parseOrThrow(res);
  return data.usuarios;
}

export async function crearUsuarioApi(
  tenantId: string,
  input: { nombre: string; email: string; password: string; rol: string }
): Promise<void> {
  const res = await platformFetch(`/tenants/${tenantId}/usuarios`, jsonInit("POST", input));
  await parseOrThrow(res);
}

export async function cambiarEstadoUsuarioApi(
  tenantId: string,
  usuarioId: string,
  activo: boolean,
  motivo?: string
): Promise<void> {
  const res = await platformFetch(
    `/tenants/${tenantId}/usuarios/${usuarioId}/estado`,
    jsonInit("PATCH", { activo, motivo })
  );
  await parseOrThrow(res);
}

export interface ModuloAsignado {
  modulo: string;
  asignado: boolean;
}

export async function obtenerModulosUsuarioApi(
  tenantId: string,
  usuarioId: string
): Promise<ModuloAsignado[]> {
  const res = await platformFetch(`/tenants/${tenantId}/usuarios/${usuarioId}/modulos`);
  const data = await parseOrThrow(res);
  return data.modulos;
}

export async function actualizarModulosUsuarioApi(
  tenantId: string,
  usuarioId: string,
  modulos: string[]
): Promise<ModuloAsignado[]> {
  const res = await platformFetch(
    `/tenants/${tenantId}/usuarios/${usuarioId}/modulos`,
    jsonInit("PUT", { modulos })
  );
  const data = await parseOrThrow(res);
  return data.modulos;
}

export interface EntradaAuditoria {
  id: string;
  accion: string;
  tenantId: string | null;
  tenantNombre: string | null;
  usuarioId: string | null;
  usuarioEmail: string | null;
  detalle: unknown;
  ip: string | null;
  requestId: string | null;
  userAgent: string | null;
  sessionId: string | null;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  resultado: string;
  creadoEn: string;
}

export interface FiltrosAuditoria {
  tenantId?: string;
  accion?: string;
  resultado?: "success" | "failure";
  sessionId?: string;
  actorId?: string;
  desde?: string;
  hasta?: string;
  cursor?: string;
  limit?: number;
}

export interface PaginaAuditoria {
  entradas: EntradaAuditoria[];
  siguienteCursor: string | null;
}

export async function listarAuditoriaApi(filtros: FiltrosAuditoria = {}): Promise<PaginaAuditoria> {
  const params = new URLSearchParams();
  for (const [clave, valor] of Object.entries(filtros)) {
    if (valor !== undefined && valor !== "") params.set(clave, String(valor));
  }
  const query = params.toString() ? `?${params.toString()}` : "";
  const res = await platformFetch(`/auditoria${query}`);
  const data = await parseOrThrow(res);
  return { entradas: data.entradas, siguienteCursor: data.siguienteCursor ?? null };
}

export interface SaludTenant {
  tenantId: string;
  usuariosActivos: number;
  usuariosTotal: number;
  ultimoAcceso: string | null;
  requestsUltimas24h: number;
  errores5xxUltimas24h: number;
  tasaError: number;
  recursosCreadosUltimas24h: number;
  alertas: string[];
}

export async function obtenerSaludTenantApi(tenantId: string): Promise<SaludTenant> {
  const res = await platformFetch(`/tenants/${tenantId}/salud`);
  const data = await parseOrThrow(res);
  return data.salud;
}

export async function obtenerSaludTodosLosTenantsApi(): Promise<SaludTenant[]> {
  const res = await platformFetch(`/tenants/salud`);
  const data = await parseOrThrow(res);
  return data.salud;
}

export interface TenantBackup {
  id: string;
  tenantId: string;
  archivo: string;
  tamanoBytes: number;
  tablas: Record<string, number>;
  estado: "completo" | "fallido";
  creadoEn: string;
}

export async function listarBackupsTenantApi(tenantId: string): Promise<TenantBackup[]> {
  const res = await platformFetch(`/tenants/${tenantId}/backups`);
  const data = await parseOrThrow(res);
  return data.backups;
}

export async function crearBackupTenantApi(tenantId: string): Promise<TenantBackup> {
  const res = await platformFetch(`/tenants/${tenantId}/backups`, { method: "POST" });
  const data = await parseOrThrow(res);
  return data.backup;
}

export async function restaurarBackupApi(
  backupId: string,
  targetTenantId: string
): Promise<Record<string, number>> {
  const res = await platformFetch(
    `/backups/${backupId}/restaurar`,
    jsonInit("POST", { targetTenantId, confirmar: true })
  );
  const data = await parseOrThrow(res);
  return data.tablasRestauradas;
}

// ── SSO / SCIM ───────────────────────────────────────────────────────────

export interface TenantSsoConfig {
  configurado: boolean;
  proveedor: "oidc" | "saml" | null;
  issuerUrl: string | null;
  clientId: string | null;
  dominioEmailPermitido: string | null;
  activo: boolean;
}

export async function obtenerSsoTenantApi(tenantId: string): Promise<TenantSsoConfig> {
  const res = await platformFetch(`/tenants/${tenantId}/sso`);
  const data = await parseOrThrow(res);
  return data.sso;
}

export async function configurarSsoTenantApi(
  tenantId: string,
  input: {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    dominioEmailPermitido?: string | null;
    activo: boolean;
  }
): Promise<TenantSsoConfig> {
  const res = await platformFetch(`/tenants/${tenantId}/sso`, jsonInit("PUT", input));
  const data = await parseOrThrow(res);
  return data.sso;
}

export interface TenantScimConfig {
  configurado: boolean;
  activo: boolean;
  creadoEn: string | null;
  rotadoEn: string | null;
}

export async function obtenerScimTenantApi(tenantId: string): Promise<TenantScimConfig> {
  const res = await platformFetch(`/tenants/${tenantId}/scim`);
  const data = await parseOrThrow(res);
  return data.scim;
}

/** El token vuelve en texto plano UNA SOLA VEZ en esta respuesta — no hay
 *  forma de volver a pedirlo después (solo se guarda el hash). */
export async function generarTokenScimApi(tenantId: string): Promise<string> {
  const res = await platformFetch(`/tenants/${tenantId}/scim/token`, { method: "POST" });
  const data = await parseOrThrow(res);
  return data.token;
}

export async function revocarTokenScimApi(tenantId: string): Promise<void> {
  const res = await platformFetch(`/tenants/${tenantId}/scim/token`, { method: "DELETE" });
  await parseOrThrow(res);
}

export async function ssoPlatformAdminDisponibleApi(): Promise<boolean> {
  const res = await platformFetch("/sso/disponible");
  const data = await parseOrThrow(res);
  return data.disponible;
}

// ── Planes y cuotas ────────────────────────────────────────────────────
// El límite efectivo se resuelve en tres niveles (override del tenant >
// plan > default del registry); `origen` dice de cuál salió, que es lo que
// permite mostrar "500 equipos (por plan Mediana)" en vez de un número
// suelto. Ver docs/architecture/cuotas-por-tenant.md.

export interface Plan {
  id: string;
  codigo: string;
  nombre: string;
  descripcion: string | null;
  activo: boolean;
  /** Menor a mayor por tamaño de empresa (el backend ya los devuelve así). */
  orden: number;
  /** null = ilimitado en ese plan; recurso ausente = el plan no opina. */
  limites: Record<string, number | null>;
}

export interface PlanDeTenant {
  planId: string | null;
  codigo: string | null;
  nombre: string | null;
}

export interface EstadoCuota {
  recurso: string;
  unidad: "cantidad" | "bytes";
  limite: number | null;
  origen: "override" | "plan" | "registry";
  uso: number;
  porcentaje: number | null;
  excedido: boolean;
}

export async function listarPlanesApi(soloActivos = false): Promise<Plan[]> {
  const res = await platformFetch(`/planes${soloActivos ? "?soloActivos=true" : ""}`);
  return (await parseOrThrow(res)).planes;
}

export async function obtenerPlanDeTenantApi(tenantId: string): Promise<PlanDeTenant> {
  const res = await platformFetch(`/tenants/${tenantId}/plan`);
  return (await parseOrThrow(res)).plan;
}

/** Devuelve también qué recursos quedan EXCEDIDOS con el plan nuevo — para
 *  poder advertirlo en el momento del cambio y no que aparezca después como
 *  creaciones rechazadas sin explicación. Nada se borra al bajar de plan. */
export async function asignarPlanTenantApi(
  tenantId: string,
  plan: string | null,
  motivo?: string
): Promise<{ plan: PlanDeTenant; recursosExcedidos: string[] }> {
  const res = await platformFetch(`/tenants/${tenantId}/plan`, jsonInit("PUT", { plan, motivo }));
  const data = await parseOrThrow(res);
  return { plan: data.plan, recursosExcedidos: data.recursosExcedidos };
}

export async function obtenerCuotasTenantApi(tenantId: string): Promise<EstadoCuota[]> {
  const res = await platformFetch(`/tenants/${tenantId}/cuotas`);
  return (await parseOrThrow(res)).cuotas;
}

export async function fijarCuotaTenantApi(
  tenantId: string,
  recurso: string,
  limite: number | null | undefined,
  motivo?: string
): Promise<EstadoCuota[]> {
  // `limite` ausente en el body = borrar el override y volver al plan/registry;
  // `null` = ilimitado. Los dos casos se distinguen por la PRESENCIA de la
  // clave, así que no se puede mandar siempre.
  const body: Record<string, unknown> = { recurso, motivo };
  if (limite !== undefined) body.limite = limite;
  const res = await platformFetch(`/tenants/${tenantId}/cuotas`, jsonInit("PUT", body));
  return (await parseOrThrow(res)).cuotas;
}
