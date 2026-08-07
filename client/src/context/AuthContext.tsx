// client/src/context/AuthContext.tsx

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { identificarUsuarioSentry } from "../config/sentry";
import { registrarSesionExpirada } from "../services/apiClient";
import { getMeApi, logoutApi, type UsuarioPayload } from "../services/authApi";

interface AuthContextType {
  usuario: UsuarioPayload | null;
  cargando: boolean;
  login: (usuario: UsuarioPayload) => void;
  logout: () => Promise<void>;
  estaAutenticado: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [usuario, setUsuario] = useState<UsuarioPayload | null>(null);
  const [cargando, setCargando] = useState(true);

  // La sesión vive en una cookie httpOnly: el cliente no puede leerla, así
  // que la única forma de saber si hay sesión activa es preguntarle al backend.
  useEffect(() => {
    getMeApi()
      .then(setUsuario)
      .catch(() => setUsuario(null))
      .finally(() => setCargando(false));
  }, []);

  // Etiqueta los eventos de Sentry con el tenant y el rol del usuario
  // activo. Acá y no en el login: este efecto también corre cuando la
  // sesión se restaura sola al abrir la app (el getMe de arriba) y cuando
  // se cae por un refresh vencido, casos que no pasan por login(). Sin
  // esto, un error reportado no dice de qué tenant vino, que es lo primero
  // que hace falta para saber si algo le pasa a un cliente o a todos.
  useEffect(() => {
    identificarUsuarioSentry(usuario);
  }, [usuario]);

  // apiFetch llama acá cuando un 401 no se pudo resolver con /api/auth/refresh
  // (refresh token vencido, revocado, o inexistente) — cualquier pantalla que
  // esté abierta debe volver a mostrar el login, no quedarse pegada mostrando
  // datos de una sesión que el backend ya no reconoce.
  useEffect(() => {
    registrarSesionExpirada(() => setUsuario(null));
  }, []);

  // Memoizadas con useCallback (identidad estable, solo llaman a setUsuario
  // que React ya garantiza estable) para que los componentes que las meten
  // en un array de dependencias de useEffect no reinicialicen ese efecto en
  // cada render.
  const login = useCallback((usuario: UsuarioPayload) => {
    setUsuario(usuario);
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutApi();
    } catch {
      // sesión de todas formas se limpia del lado del cliente
    }
    setUsuario(null);
  }, []);

  return (
    <AuthContext.Provider value={{ usuario, cargando, login, logout, estaAutenticado: !!usuario }}>
      {children}
    </AuthContext.Provider>
  );
}

// Colocar el hook junto a su Provider en el mismo archivo es el patrón
// estándar de Context en React -- separarlo a otro archivo solo por Fast
// Refresh sería más ruido que valor para un solo hook.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return ctx;
}
