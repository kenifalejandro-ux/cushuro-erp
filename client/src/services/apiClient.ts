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

/** AuthContext se registra acá para enterarse cuando el refresh también
 *  falla (refresh token vencido o revocado) y así limpiar el usuario en
 *  memoria y mandar a /login. */
export function registrarSesionExpirada(callback: () => void) {
  onSesionExpirada = callback;
}

async function refrescarAccessToken(): Promise<boolean> {
  // Una sola llamada a /refresh aunque varios requests reciban 401 al mismo
  // tiempo: el backend rota el refresh token en cada uso y trata un reuso
  // como robo, revocando la sesión entera (ver auth.service.ts,
  // refrescarTokenService) — disparar el refresh dos veces en paralelo la
  // mataría por accidente.
  if (!refrescoEnCurso) {
    refrescoEnCurso = fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
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
