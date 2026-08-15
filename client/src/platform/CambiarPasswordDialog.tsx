// client/src/platform/CambiarPasswordDialog.tsx
//
// Cambio de contraseña self-service del Platform Admin logueado (ver
// PATCH /api/platform/mi-cuenta/password). Al confirmar, el backend revoca
// la sesión actual junto con el resto — onExito cierra el modal y avisa al
// caller para que mande de vuelta al login con la contraseña nueva.

import { useState, type FormEvent } from "react";

import PasswordInput from "./PasswordInput";
import { cambiarPasswordPropioApi } from "./platformApi";

export default function CambiarPasswordDialog({
  onExito,
  onCancelar,
}: {
  onExito: () => void;
  onCancelar: () => void;
}) {
  const [passwordActual, setPasswordActual] = useState("");
  const [passwordNueva, setPasswordNueva] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (passwordNueva !== confirmacion) {
      setError("La confirmación no coincide con la contraseña nueva");
      return;
    }

    setEnviando(true);
    try {
      await cambiarPasswordPropioApi(passwordActual, passwordNueva);
      onExito();
    } catch (err: any) {
      setError(err.message || "No se pudo cambiar la contraseña");
      setEnviando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <form
        onSubmit={handleSubmit}
        className="bg-slate-900 border border-slate-800 rounded-xl p-5 w-full max-w-sm"
      >
        <h3 className="text-sm font-medium text-slate-100 mb-1">Cambiar contraseña</h3>
        <p className="text-xs text-slate-500 mb-3">
          Al confirmar se cierra esta sesión (y cualquier otra abierta) — vas a tener que volver a
          entrar con la contraseña nueva.
        </p>

        <div className="space-y-3 mb-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1" htmlFor="passwordActual">
              Contraseña actual
            </label>
            <PasswordInput
              id="passwordActual"
              value={passwordActual}
              onChange={setPasswordActual}
              required
              autoComplete="current-password"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1" htmlFor="passwordNueva">
              Contraseña nueva
            </label>
            <PasswordInput
              id="passwordNueva"
              value={passwordNueva}
              onChange={setPasswordNueva}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1" htmlFor="confirmacion">
              Confirmar contraseña nueva
            </label>
            <PasswordInput
              id="confirmacion"
              value={confirmacion}
              onChange={setConfirmacion}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2 mb-3">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancelar}
            disabled={enviando}
            className="px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:text-slate-100 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={enviando}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-100 text-slate-900 hover:bg-white disabled:opacity-50 transition-colors"
          >
            {enviando ? "Guardando..." : "Cambiar contraseña"}
          </button>
        </div>
      </form>
    </div>
  );
}
