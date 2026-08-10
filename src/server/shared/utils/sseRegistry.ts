/** src/server/shared/utils/sseRegistry.ts
 *
 * Una conexión SSE se queda abierta indefinidamente A PROPÓSITO (es un
 * stream). `server.close()` en bootstrap.ts espera a que TODAS las
 * conexiones abiertas se cierren solas antes de invocar su callback —
 * sin este registro, un `SIGTERM` de deploy se queda colgado esperando
 * streams que nunca van a cerrarse por su cuenta. shutdown() en
 * bootstrap.ts llama a cerrarConexionesSSE() antes de dar por terminado
 * el apagado.
 */
import type { Response } from "express";

const conexionesActivas = new Set<Response>();

export function registrarConexionSSE(res: Response): void {
  conexionesActivas.add(res);
}

export function quitarConexionSSE(res: Response): void {
  conexionesActivas.delete(res);
}

/** Termina cada stream activo con un `end()` explícito -- deja que
 *  `server.close()` complete en vez de esperar indefinidamente. */
export function cerrarConexionesSSE(): void {
  for (const res of conexionesActivas) {
    res.end();
  }
  conexionesActivas.clear();
}
