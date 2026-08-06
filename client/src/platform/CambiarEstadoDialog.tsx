// client/src/platform/CambiarEstadoDialog.tsx
//
// Modal chico para pedir un motivo opcional antes de activar/desactivar un
// tenant o un usuario — el motivo queda en el detalle del evento de
// auditoría (ver cambiarEstadoTenantService/cambiarEstadoUsuarioService).

import { useState, type FormEvent } from "react";

export default function CambiarEstadoDialog({
  activarA,
  entidadNombre,
  onConfirmar,
  onCancelar,
}: {
  activarA: boolean;
  entidadNombre: string;
  onConfirmar: (motivo: string | undefined) => Promise<void>;
  onCancelar: () => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      await onConfirmar(motivo.trim() || undefined);
    } catch (err: any) {
      setError(err.message || "No se pudo completar la acción");
      setEnviando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <form
        onSubmit={handleSubmit}
        className="bg-slate-900 border border-slate-800 rounded-xl p-5 w-full max-w-sm"
      >
        <h3 className="text-sm font-medium text-slate-100 mb-1">
          {activarA ? "Activar" : "Desactivar"} {entidadNombre}
        </h3>
        <p className="text-xs text-slate-500 mb-3">
          El motivo es opcional, pero queda en la auditoría.
        </p>

        <textarea
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Motivo (opcional)"
          rows={3}
          maxLength={500}
          autoFocus
          className="w-full px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30 mb-3"
        />

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
            className={`px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors ${
              activarA
                ? "bg-emerald-950 text-emerald-400 hover:bg-emerald-900"
                : "bg-red-950 text-red-400 hover:bg-red-900"
            }`}
          >
            {enviando ? "Guardando..." : activarA ? "Activar" : "Desactivar"}
          </button>
        </div>
      </form>
    </div>
  );
}
