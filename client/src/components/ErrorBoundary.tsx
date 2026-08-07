/** client/src/components/ErrorBoundary.tsx
 *
 * Red de contención para los errores de RENDER de React, que son los que
 * Sentry no ve solo: un error tirado durante el render no burbujea a
 * window.onerror, así que sin un ErrorBoundary no se reporta a ningún lado
 * — y encima React desmonta todo el árbol, dejándole al usuario una
 * pantalla en blanco sin ninguna explicación.
 *
 * Tiene que ser una clase: hoy no existe equivalente en hooks
 * (componentDidCatch no tiene versión funcional).
 */
import React from "react";

import { capturarError } from "../config/sentry";

interface Props {
  children: React.ReactNode;
}

interface State {
  falló: boolean;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { falló: false };

  static getDerivedStateFromError(): State {
    return { falló: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // componentStack dice en qué componente reventó, que es lo primero que
    // se busca al abrir el evento en Sentry. No-op si no hay DSN.
    capturarError(error, { componentStack: info.componentStack });
  }

  render() {
    if (!this.state.falló) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen bg-[#DDF500] flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-[#FFFFFF] border border-slate-200 rounded-xl p-6 shadow-sm text-center">
          <h1 className="text-lg font-semibold text-slate-900">Algo salió mal</h1>
          <p className="mt-2 text-sm text-slate-600">
            La pantalla no se pudo cargar. El error ya quedó registrado.
          </p>
          {/* Recarga entera y no un reintento del render: si el estado de la
              app fue lo que rompió el render, reintentar sobre ese mismo
              estado vuelve a fallar igual. */}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 w-full px-3 py-2 rounded-lg bg-[#1D2124] text-sm font-medium text-white hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-slate-900/20"
          >
            Recargar
          </button>
        </div>
      </div>
    );
  }
}
