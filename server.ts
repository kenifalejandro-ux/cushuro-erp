import { startServer } from "./src/server/bootstrap";

startServer().catch((err) => {
  console.error("Error fatal al arrancar el server", err);
  process.exit(1);
});
