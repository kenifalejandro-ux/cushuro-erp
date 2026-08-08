/** scripts/restoreDrillEscritura.ts
 *
 * Corre el restore drill de ESCRITURA (platformBackupWriteDrill.worker.ts)
 * a demanda, igual que scripts/restoreDrill.ts hace con el de lectura —
 * para probarlo justo después de construirlo, o para chequear "¿el camino
 * de escritura del restore todavía funciona?" sin esperar a la próxima
 * corrida programada (semanal por default).
 *
 * A diferencia del worker automático, acá se fuerza `habilitado: true` sin
 * importar BACKUP_WRITE_DRILL_ENABLED — correrlo a mano es una decisión
 * explícita de quien lo ejecuta, no necesita el opt-in del worker.
 *
 * Uso:
 *   npm run backup:restore-drill:escritura
 */
import { correrRestoreDrillEscritura } from "../src/server/services/platformBackupWriteDrill.worker";
import { closeDatabase } from "../src/server/config/database";

async function main(): Promise<void> {
  console.log(
    "Restore drill de escritura — restaurando el backup completo más reciente sobre un tenant descartable...\n"
  );

  const resultado = await correrRestoreDrillEscritura({ habilitado: true });

  if (!resultado) {
    console.log("Todavía no hay ningún backup completo para probar.");
    await closeDatabase();
    process.exit(0);
  }

  console.log(`Backup:            ${resultado.backupId}`);
  console.log(`Tenant original:   ${resultado.tenantOriginalId}`);
  console.log(`Tenant descartable: ${resultado.tenantDrillId} (rollback — no queda en la base)`);

  if (resultado.ok) {
    console.log("\n✓ Restaurado y verificado OK — el camino de escritura funciona.");
  } else if (resultado.error) {
    console.log(`\n✗ Falló antes de completar la verificación: ${resultado.error}`);
  } else {
    console.log(`\n✗ No coincide con su manifiesto: ${resultado.discrepancias.join(", ")}`);
  }

  await closeDatabase();
  process.exit(resultado.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("Error corriendo el restore drill de escritura:", err);
  process.exit(1);
});
