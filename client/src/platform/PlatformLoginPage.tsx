// client/src/platform/PlatformLoginPage.tsx

import { useEffect, useState, type FormEvent } from "react";

import {
  iniciarSesionPlataformaApi,
  iniciarSesionAdminApi,
  ssoPlatformAdminDisponibleApi,
} from "./platformApi";

export default function PlatformLoginPage({ onExito }: { onExito: () => void }) {
  const [mostrarEmergencia, setMostrarEmergencia] = useState(false);
  const [ssoDisponible, setSsoDisponible] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);

  useEffect(() => {
    ssoPlatformAdminDisponibleApi()
      .then(setSsoDisponible)
      .catch(() => setSsoDisponible(false));

    const params = new URLSearchParams(window.location.search);
    const error = params.get("ssoError");
    if (error) {
      // Lectura única de un query param al montar (sincronización con la
      // URL, no un valor derivado de props/state) -- caso legítimo de
      // efecto según la propia guía de React.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSsoError(error);
      params.delete("ssoError");
      const resto = params.toString();
      window.history.replaceState(null, "", resto ? `?${resto}` : window.location.pathname);
    }
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="w-11 h-11 bg-slate-100 rounded-lg flex items-center justify-center">
            <span className="text-slate-900 font-semibold text-base">M</span>
          </div>
          <h1 className="text-xl font-light text-slate-100 tracking-tight">Panel de plataforma</h1>
          <p className="text-xs text-slate-400 text-center">
            No es el login del ERP — esto administra todos los tenants a la vez.
          </p>
        </div>

        {ssoError && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2 mb-4">
            {ssoError}
          </p>
        )}

        {mostrarEmergencia ? (
          <EmergenciaForm onExito={onExito} />
        ) : (
          <AdminLoginForm onExito={onExito} />
        )}

        {!mostrarEmergencia && ssoDisponible && (
          <button
            onClick={() => {
              window.location.href = "/api/platform/sso/iniciar";
            }}
            className="w-full mt-3 py-2.5 rounded-lg border border-slate-700 text-slate-100 text-sm font-medium hover:bg-slate-900 transition-colors"
          >
            Iniciar sesión con SSO
          </button>
        )}

        <button
          onClick={() => setMostrarEmergencia((v) => !v)}
          className="w-full text-center text-xs text-slate-500 hover:text-slate-300 mt-4"
        >
          {mostrarEmergencia
            ? "← Volver a iniciar sesión"
            : "¿Problemas para entrar? Usar acceso de emergencia"}
        </button>
      </div>
    </div>
  );
}

function AdminLoginForm({ onExito }: { onExito: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      await iniciarSesionAdminApi(email, password);
      onExito();
    } catch (err: any) {
      setError(err.message || "No se pudo iniciar sesión");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4"
    >
      <div>
        <label className="block text-sm font-light text-slate-300 mb-1.5" htmlFor="email">
          Correo
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30 focus:border-slate-500"
          placeholder="admin@mincoreerp.com"
        />
      </div>

      <div>
        <label className="block text-sm font-light text-slate-300 mb-1.5" htmlFor="password">
          Contraseña
        </label>
        <input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30 focus:border-slate-500"
        />
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={enviando}
        className="w-full py-2.5 rounded-lg bg-slate-100 text-slate-900 text-sm font-medium hover:bg-white disabled:opacity-50 transition-colors"
      >
        {enviando ? "Verificando..." : "Entrar"}
      </button>
    </form>
  );
}

function EmergenciaForm({ onExito }: { onExito: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      await iniciarSesionPlataformaApi(token);
      onExito();
    } catch (err: any) {
      setError(err.message || "No se pudo iniciar sesión");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-slate-900 border border-amber-900/40 rounded-xl p-6 space-y-4"
    >
      <p className="text-xs text-amber-400/80 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2">
        Acceso de emergencia: usa el secreto compartido de la plataforma en vez de una cuenta
        individual. Queda marcado como tal en la auditoría.
      </p>

      <div>
        <label className="block text-sm font-light text-slate-300 mb-1.5" htmlFor="token">
          Token de plataforma
        </label>
        <input
          id="token"
          type="password"
          required
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30 focus:border-slate-500"
          placeholder="PLATFORM_ADMIN_TOKEN"
        />
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={enviando}
        className="w-full py-2.5 rounded-lg bg-slate-100 text-slate-900 text-sm font-medium hover:bg-white disabled:opacity-50 transition-colors"
      >
        {enviando ? "Verificando..." : "Entrar en modo emergencia"}
      </button>
    </form>
  );
}
