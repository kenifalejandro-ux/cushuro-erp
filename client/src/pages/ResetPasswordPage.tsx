// client/src/pages/ResetPasswordPage.tsx
//
// Se renderiza fuera de <AuthProvider> (ver main.tsx) — no necesita ni
// puede usar useAuth(), el token de la URL ya identifica todo lo que hace
// falta del lado del backend (ver restablecerPasswordService).

import { useState, type FormEvent } from "react";

import { resetPasswordApi } from "../services/authApi";

export default function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const [password, setPassword] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState(false);
  const [enviando, setEnviando] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmacion) {
      setError("Las contraseñas no coinciden");
      return;
    }

    setEnviando(true);
    try {
      await resetPasswordApi(token, password);
      setListo(true);
    } catch (err: any) {
      setError(err.message || "No se pudo restablecer la contraseña");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#DDF500] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="w-11 h-11 bg-[#FFFFFF] rounded-lg flex items-center justify-center">
            <span className="text-zinc-900 font-semibold text-base">M</span>
          </div>
          <h1 className="text-xl font-light text-slate-900 tracking-tight">MinCore ERP</h1>
        </div>

        <div className="bg-[#1D2124] border border-slate-200 rounded-xl p-6 space-y-4 shadow-sm">
          {!token && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              Este link no incluye un token válido. Solicita uno nuevo desde la pantalla de login.
            </p>
          )}

          {token && listo && (
            <>
              <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
                Contraseña actualizada correctamente. Ya puedes iniciar sesión con tu nueva
                contraseña.
              </p>
              <a
                href="/"
                className="block w-full text-center py-2.5 rounded-lg bg-[#DDF500] text-zinc-900 text-sm font-medium hover:bg-[#DDF500]/80 transition-colors"
              >
                Ir a iniciar sesión
              </a>
            </>
          )}

          {token && !listo && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  className="block text-sm font-light text-slate-100 mb-1.5"
                  htmlFor="password"
                >
                  Nueva contraseña
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400"
                  placeholder="••••••••"
                />
              </div>

              <div>
                <label
                  className="block text-sm font-light text-slate-100 mb-1.5"
                  htmlFor="confirmacion"
                >
                  Confirmar contraseña
                </label>
                <input
                  id="confirmacion"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={confirmacion}
                  onChange={(e) => setConfirmacion(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-400"
                  placeholder="••••••••"
                />
              </div>

              {error && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={enviando}
                className="w-full py-2.5 rounded-lg bg-[#DDF500] text-zinc-900 text-sm font-medium hover:bg-[#DDF500]/80 disabled:opacity-50 transition-colors"
              >
                {enviando ? "Guardando..." : "Guardar nueva contraseña"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
