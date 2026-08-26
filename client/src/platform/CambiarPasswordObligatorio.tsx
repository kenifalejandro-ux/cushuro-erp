// client/src/platform/CambiarPasswordObligatorio.tsx
//
// Pantalla completa (no un modal superpuesto) que PlatformApp.tsx muestra
// en vez del panel cuando whoami.debeCambiarPassword es true — la cuenta
// entró con una clave temporal que el creador le pasó por fuera del
// sistema, y no tiene forma de saltear esta pantalla salvo cambiarla.

import { useState, type FormEvent } from "react";

import PasswordInput from "./PasswordInput";
import { cambiarMiPasswordApi } from "./platformApi";

export default function CambiarPasswordObligatorio({ onListo }: { onListo: () => void }) {
  const [passwordActual, setPasswordActual] = useState("");
  const [passwordNueva, setPasswordNueva] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (passwordNueva !== confirmacion) {
      setError("Las contraseñas no coinciden");
      return;
    }

    setEnviando(true);
    try {
      await cambiarMiPasswordApi(passwordActual, passwordNueva);
      onListo();
    } catch (err: any) {
      setError(err.message || "No se pudo cambiar la contraseña");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="w-11 h-11 bg-slate-100 rounded-lg flex items-center justify-center">
            <span className="text-slate-900 font-semibold text-base">M</span>
          </div>
          <h1 className="text-xl font-light text-slate-100 tracking-tight">
            Poné tu propia contraseña
          </h1>
          <p className="text-xs text-slate-400 text-center">
            Entraste con una clave temporal. Antes de seguir, tenés que reemplazarla por una propia.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4"
        >
          <div>
            <label
              className="block text-sm font-light text-slate-300 mb-1.5"
              htmlFor="passwordActual"
            >
              Contraseña temporal
            </label>
            <PasswordInput
              id="passwordActual"
              required
              autoComplete="current-password"
              value={passwordActual}
              onChange={setPasswordActual}
            />
          </div>

          <div>
            <label
              className="block text-sm font-light text-slate-300 mb-1.5"
              htmlFor="passwordNueva"
            >
              Nueva contraseña
            </label>
            <PasswordInput
              id="passwordNueva"
              required
              minLength={8}
              autoComplete="new-password"
              value={passwordNueva}
              onChange={setPasswordNueva}
            />
          </div>

          <div>
            <label
              className="block text-sm font-light text-slate-300 mb-1.5"
              htmlFor="confirmacion"
            >
              Confirmar nueva contraseña
            </label>
            <PasswordInput
              id="confirmacion"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirmacion}
              onChange={setConfirmacion}
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
            {enviando ? "Guardando..." : "Guardar y continuar"}
          </button>
        </form>
      </div>
    </div>
  );
}
