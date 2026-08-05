/** scripts/restoreDrill.ts
 *
 * Corre el restore drill (platformBackupDrill.worker.ts) a demanda, fuera
 * del ciclo automático diario — para probarlo justo después de configurar
 * backups por primera vez, o para chequear "¿están bien los backups AHORA
 * mismo?" sin esperar a la próxima corrida programada.
 *
 * Uso:
 *   npm run backup:restore-drill
 *
 * Reusa exactamente la misma función que corre el worker periódico
 * (correrRestoreDrill()) — este script no reimplementa ninguna lógica de
 * validación, solo la invoca manualmente y presenta el resultado en la
 * terminal. Termina con código de salida distinto de 0 si algún backup no
 * pasó la verificación, para poder engancharlo a un chequeo de CI/cron sin
 * tener que parsear los logs.
 */
import { correrRestoreDrill, type ResultadoDrillBackup } from "../src/server/services/platformBackupDrill.worker";
import { closeDatabase } from "../src/server/config/database";

function imprimirResultado(etiqueta: string, resultado: ResultadoDrillBackup): void {
  if (resultado.ok) {
    console.log(`  ✓ ${etiqueta} — backup ${resultado.backupId}`);
    return;
  }
  if (resultado.error) {
    console.log(`  ✗ ${etiqueta} — backup ${resultado.backupId}: no se pudo leer (${resultado.error})`);
  } else {
    console.log(
      `  ✗ ${etiqueta} — backup ${resultado.backupId}: no coincide con su manifiesto (${resultado.discrepancias.join(", ")})`
    );
  }
}

async function main(): Promise<void> {
  console.log("Restore drill — validando el backup más reciente de cada tenant y el de plataforma...\n");

  const resumen = await correrRestoreDrill();

  console.log(`Tenants (${resumen.tenants.length} verificados):`);
  if (resumen.tenants.length === 0) {
    console.log("  (ningún tenant tiene todavía un backup completo)");
  }
  for (const resultado of resumen.tenants) {
    imprimirResultado("tenant", resultado);
  }

  console.log("\nPlataforma:");
  if (resumen.plataforma) {
    imprimirResultado("plataforma", resumen.plataforma);
  } else {
    console.log("  (todavía no hay ningún backup de plataforma)");
  }

  const fallidos = [...resumen.tenants, ...(resumen.plataforma ? [resumen.plataforma] : [])].filter((r) => !r.ok);

  console.log(
    `\n${resumen.tenants.length + (resumen.plataforma ? 1 : 0)} backups verificados, ${fallidos.length} fallaron.`
  );

  await closeDatabase();
  process.exit(fallidos.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Error corriendo el restore drill:", err);
  process.exit(1);
});
