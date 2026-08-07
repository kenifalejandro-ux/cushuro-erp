import "./src/server/config/sentry"; // primer import a propósito -- Sentry.init() debe correr antes de que se importen express/http/pg para poder instrumentarlos

import { startServer } from "./src/server/bootstrap";

startServer().catch((err) => {
  console.error("Error fatal al arrancar el server", err);
  process.exit(1);
});
