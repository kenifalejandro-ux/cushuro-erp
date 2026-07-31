import { runMigrations } from "./src/server/config/migrate";
import { closeDatabase } from "./src/server/config/database";

runMigrations()
  .then(() => closeDatabase())
  .then(() => {
    console.log("Migraciones al día.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Error al correr migraciones", err);
    process.exit(1);
  });
