/** scripts/onboardTenant.ts
 *
 * CLI de aprovisionamiento de un tenant nuevo — mismo servicio que usa
 * POST /api/platform/tenants/onboard (tenantOnboardingService.ts), sin
 * pasar por HTTP: útil para levantar un cliente nuevo desde una terminal
 * con acceso directo a la base (deploy inicial, soporte), sin necesitar el
 * token de super-admin de plataforma.
 *
 * Uso:
 *   npm run tenant:create -- --tenantNombre="Minera Cushuro" --tenantSlug=cushuro \
 *     --adminNombre="Admin Cushuro" --adminEmail=admin@cushuro.com --adminPassword=... \
 *     [--planCodigo=mediana]
 *
 * (El "--" después de "tenant:create" es necesario: sin él, npm se queda
 * con los flags para sí mismo en vez de pasárselos al script.)
 */
import { closeDatabase } from "../src/server/config/database";
import { onboardTenantService } from "../src/server/services/tenantOnboardingService";
import type { OnboardTenantInput } from "../src/server/schemas/platform.schema";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...resto] = arg.replace(/^--/, "").split("=");
    return [key, resto.join("=")];
  })
);

const CAMPOS_REQUERIDOS = ["tenantNombre", "tenantSlug", "adminNombre", "adminEmail", "adminPassword"] as const;

function leerInput(): OnboardTenantInput {
  const faltantes = CAMPOS_REQUERIDOS.filter((campo) => !args.get(campo));
  if (faltantes.length > 0) {
    console.error(`Faltan argumentos requeridos: ${faltantes.join(", ")}`);
    console.error(
      "Uso: npm run tenant:create -- --tenantNombre=... --tenantSlug=... --adminNombre=... --adminEmail=... --adminPassword=... [--planCodigo=...]"
    );
    process.exit(1);
  }

  return {
    tenantNombre: args.get("tenantNombre")!,
    tenantSlug: args.get("tenantSlug")!,
    adminNombre: args.get("adminNombre")!,
    adminEmail: args.get("adminEmail")!,
    adminPassword: args.get("adminPassword")!,
    planCodigo: args.get("planCodigo"),
  };
}

async function main() {
  const input = leerInput();

  const resultado = await onboardTenantService(input, {
    ip: "127.0.0.1",
    actorType: "system",
    actorLabel: "cli:tenant:create",
  });

  console.log("Tenant aprovisionado correctamente:");
  console.log(JSON.stringify(resultado, null, 2));
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("Error al aprovisionar el tenant:", err instanceof Error ? err.message : err);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
