// client/src/services/apiClient.ts
//
// El access token dura 30 min (ver JWT_EXPIRES en el backend). fetch() no
// reintenta solo cuando ese token expira — sin este wrapper, cualquier
// pantalla abierta por más de 30 min empezaría a recibir 401 y se vería
// como una sesión "cortada", aunque el refresh token siga vigente.
//
// Toda llamada a /api/erp/* debe pasar por apiFetch en vez de fetch()
// directo.

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

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
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
