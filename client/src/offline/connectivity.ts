// client/src/offline/connectivity.ts
//
// Estado de conexión, para el badge de la UI y para saber cuándo drenar la
// cola.
//
// `navigator.onLine` solo dice si hay una interfaz de red levantada — es
// famoso por dar true con un wifi conectado que no tiene salida (portal
// cautivo, router sin internet, Starlink enlazado pero sin señal). En una
// planta minera ese caso no es raro. Por eso `onLine === true` acá es solo
// un permiso para PROBAR, y la confirmación real la da un GET a /api/health
// (barato, sin auth, no cacheado por el service worker).
//
// El caso contrario sí es confiable: `onLine === false` significa que no
// hay ninguna interfaz, así que ni vale la pena intentar el probe.

/** El backend responde este endpoint sin auth y con Cache-Control:
 *  no-store (ver src/server/app.ts). No se usa /api/auth/refresh a
 *  propósito: rota el refresh token y un reuso se trata como robo de
 *  sesión, así que un latido periódico contra él desloguearía al usuario. */
const URL_PROBE = "/api/health";
const TIMEOUT_PROBE_MS = 5000;

type Oyente = (online: boolean) => void;
const oyentes = new Set<Oyente>();

let ultimoEstado = typeof navigator === "undefined" ? true : navigator.onLine;

export function estaOnline(): boolean {
  return ultimoEstado;
}

export function suscribirseAConectividad(oyente: Oyente): () => void {
  oyentes.add(oyente);
  oyente(ultimoEstado);
  return () => oyentes.delete(oyente);
}

function publicarEstado(online: boolean): void {
  if (online === ultimoEstado) return;
  ultimoEstado = online;
  for (const oyente of oyentes) oyente(online);
}

/** Confirma con el servidor que hay salida real, no solo interfaz de red.
 *  Devuelve false ante cualquier error o timeout — offline es la
 *  suposición segura: como mucho encola algo que se podría haber mandado,
 *  y eso se corrige solo en la próxima pasada de sincronización. */
export async function hayConexionReal(): Promise<boolean> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;

  const abortador = new AbortController();
  const timeout = setTimeout(() => abortador.abort(), TIMEOUT_PROBE_MS);
  try {
    // cache: "no-store" además del header del servidor: sin esto, el
    // navegador podría responder el probe desde su propia caché HTTP y
    // dar "online" sin haber tocado la red.
    const res = await fetch(URL_PROBE, {
      method: "GET",
      cache: "no-store",
      signal: abortador.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** Registra los listeners del navegador. Idempotente: llamarlo dos veces
 *  no duplica handlers. */
let iniciado = false;

export function iniciarMonitoreoDeConexion(alReconectar: () => void): void {
  if (iniciado || typeof window === "undefined") return;
  iniciado = true;

  window.addEventListener("offline", () => publicarEstado(false));

  window.addEventListener("online", () => {
    // No se confía en el evento por sí solo (ver el comentario del
    // archivo): dispara apenas hay interfaz, que es justo cuando todavía
    // puede no haber salida. Se confirma con el probe antes de anunciar
    // "volvió la red" y de largar la sincronización.
    void hayConexionReal().then((real) => {
      publicarEstado(real);
      if (real) alReconectar();
    });
  });
}

/** Marca el estado desde afuera: apiFetch ya sabe si una request salió o
 *  falló por red, y esa señal es más fiel que cualquier probe periódico —
 *  es tráfico real de la app, no un latido sintético. */
export function reportarResultadoDeRed(exitoso: boolean): void {
  publicarEstado(exitoso);
}
