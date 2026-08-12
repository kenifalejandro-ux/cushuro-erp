// client/src/services/apiClient.ts
//
// El access token dura 30 min (ver JWT_EXPIRES en el backend). fetch() no
// reintenta solo cuando ese token expira — sin este wrapper, cualquier
// pantalla abierta por más de 30 min empezaría a recibir 401 y se vería
// como una sesión "cortada", aunque el refresh token siga vigente.
//
// Toda llamada a /api/erp/* debe pasar por apiFetch en vez de fetch()
// directo.
//
// apiFetch es además el único punto donde se decide qué se encola cuando no
// hay red (ver client/src/offline/): es el embudo por el que ya pasa toda
// llamada al ERP, así que no hace falta que cada vista sepa nada del
// offline. Qué rutas califican lo declara el registry de módulos, no este
// archivo.

import { reportarResultadoDeRed } from "../offline/connectivity";
import { encolar } from "../offline/offlineQueue";
import { moduloParaEncolar } from "../offline/rutasOffline";
import { usuarioActivo } from "../offline/sesionOffline";

let refrescoEnCurso: Promise<boolean> | null = null;
let onSesionExpirada: (() => void) | null = null;

// Nombre del lock coordinado por el navegador (ver refrescarAccessToken).
const LOCK_REFRESH = "erp-refresh-token";

/** AuthContext se registra acá para enterarse cuando el refresh también
 *  falla (refresh token vencido o revocado) y así limpiar el usuario en
 *  memoria y mandar a /login. */
export function registrarSesionExpirada(callback: () => void) {
  onSesionExpirada = callback;
}

async function pedirRefreshAlServidor(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
    return res.ok;
  } catch {
    return false;
  }
}

async function refrescarAccessToken(): Promise<boolean> {
  // El backend rota el refresh token en cada uso y trata un reuso como
  // robo, revocando la sesión entera (ver auth.service.ts,
  // refrescarTokenService) — así que dos pestañas del mismo navegador
  // cuyo access token vence casi al mismo tiempo NO pueden llamar a
  // /refresh en paralelo: la segunda perdería la carrera contra la
  // rotación de la primera y tumbaría la sesión en todos los
  // dispositivos, como si hubiera sido un ataque real.
  //
  // navigator.locks coordina esto entre TODAS las pestañas del mismo
  // origen en el mismo navegador (no solo dentro de una pestaña como el
  // fallback de abajo). Cuando la segunda pestaña por fin obtiene el
  // lock, el navegador ya tiene la cookie nueva que dejó la primera —
  // así que su propio fetch sale con la cookie al día, sin colisión.
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return navigator.locks.request(LOCK_REFRESH, () => pedirRefreshAlServidor());
  }

  // Fallback para navegadores sin Web Locks API: al menos serializa
  // dentro de esta misma pestaña (protección parcial, mejor que nada).
  if (!refrescoEnCurso) {
    refrescoEnCurso = pedirRefreshAlServidor().finally(() => {
      refrescoEnCurso = null;
    });
  }
  return refrescoEnCurso;
}

const SIN_REINTENTO = ["/api/auth/login", "/api/auth/refresh", "/api/auth/logout"];

/** El camino de siempre: manda la request y, ante un 401, refresca el
 *  token y reintenta una vez. NO toca la cola offline — si falla por red,
 *  tira.
 *
 *  Lo usa offlineSync.ts al drenar la cola: si esas requests pasaran por
 *  apiFetch, un fallo de red las volvería a encolar (ya están en la cola) y
 *  el drenaje se perseguiría la cola a sí mismo. */
export async function enviarSinCola(input: string, init?: RequestInit): Promise<Response> {
  const respuesta = await fetch(input, { credentials: "include", ...init });

  if (respuesta.status !== 401 || SIN_REINTENTO.some((ruta) => input.startsWith(ruta))) {
    return respuesta;
  }

  const seRefresco = await refrescarAccessToken();
  if (!seRefresco) {
    onSesionExpirada?.();
    return respuesta;
  }

  return fetch(input, { credentials: "include", ...init });
}

/** Respuesta sintética para el que llamó cuando la escritura quedó
 *  encolada. 202 Accepted es literalmente el código para "lo recibí, lo voy
 *  a procesar más tarde" — y al ser 2xx, `res.ok` es true, así que una
 *  vista que solo mira `res.ok` cierra su modal y no le muestra un error al
 *  operario por algo que NO se perdió.
 *
 *  Una vista que quiera distinguirlo (para decir "se sincronizará al
 *  volver la señal") mira el status 202 o el flag del body. */
function respuestaEncolada(clienteUuid: string): Response {
  return new Response(JSON.stringify({ pendienteDeSincronizar: true, cliente_uuid: clienteUuid }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    const respuesta = await enviarSinCola(input, init);
    // Llegó respuesta del servidor (aunque sea un 500): hay red.
    reportarResultadoDeRed(true);
    return respuesta;
  } catch (err) {
    // fetch() SOLO tira por fallo de red (DNS, sin ruta, conexión cortada,
    // CORS). Un 4xx/5xx llega como Response y sale por el return de
    // arriba, no por acá. Esa es toda la distinción que hace falta entre
    // "no se pudo mandar" (encolar) y "el servidor lo rechazó" (mostrar el
    // error, no reintentar para siempre).
    reportarResultadoDeRed(false);

    const moduloId = moduloParaEncolar(input, init?.method ?? "GET");
    if (!moduloId) throw err;

    // Sin cliente_uuid en el body no hay forma de que el servidor
    // deduplique el reintento, así que encolarlo arriesgaría duplicar.
    // Mejor que falle acá y se vea, que aceptar algo que puede corromper
    // datos más tarde.
    const clienteUuid = leerClienteUuid(init?.body);
    if (!clienteUuid) throw err;

    await encolar({
      clienteUuid,
      usuarioId: usuarioActivo(),
      moduloId,
      url: input,
      metodo: (init?.method ?? "POST").toUpperCase(),
      body: typeof init?.body === "string" ? init.body : JSON.stringify(init?.body ?? {}),
      creadoEn: Date.now(),
      intentos: 0,
    });
    return respuestaEncolada(clienteUuid);
  }
}

/** El uuid viaja dentro del body JSON que armó la vista — no en un header
 *  aparte — para que sea el MISMO valor que el servidor persiste, sin
 *  posibilidad de que se desincronicen. */
function leerClienteUuid(body: BodyInit | null | undefined): string | null {
  if (typeof body !== "string") return null;
  try {
    const parseado: unknown = JSON.parse(body);
    if (parseado && typeof parseado === "object" && "cliente_uuid" in parseado) {
      const valor = (parseado as { cliente_uuid: unknown }).cliente_uuid;
      return typeof valor === "string" ? valor : null;
    }
  } catch {
    // No era JSON (FormData serializada, texto plano): no es encolable.
  }
  return null;
}
