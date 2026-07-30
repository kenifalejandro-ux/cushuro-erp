// client/src/context/AuthContext.tsx

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getMeApi, logoutApi, type UsuarioPayload } from "../services/authApi";
import { registrarSesionExpirada } from "../services/apiClient";

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

  // apiFetch llama acá cuando un 401 no se pudo resolver con /api/auth/refresh
  // (refresh token vencido, revocado, o inexistente) — cualquier pantalla que
  // esté abierta debe volver a mostrar el login, no quedarse pegada mostrando
  // datos de una sesión que el backend ya no reconoce.
  useEffect(() => {
    registrarSesionExpirada(() => setUsuario(null));
  }, []);

  function login(usuario: UsuarioPayload) {
    setUsuario(usuario);
  }

  async function logout() {
    try {
      await logoutApi();
    } catch {
      // sesión de todas formas se limpia del lado del cliente
    }
    setUsuario(null);
  }

  return (
    <AuthContext.Provider
      value={{ usuario, cargando, login, logout, estaAutenticado: !!usuario }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return ctx;
}
