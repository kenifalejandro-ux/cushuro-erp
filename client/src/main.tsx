// client/src/main.tsx

// PRIMER import a propósito: Sentry.init() tiene que correr antes de que
// React monte, o los errores que ocurren durante el arranque no se capturan.
// Mismo criterio que server.ts en el backend.
import "./config/sentry";

import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AuthProvider } from "./context/AuthContext";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import PlatformApp from "./platform/PlatformApp";

// Importaciones globales (mantén solo las que realmente uses)
import "./styles/globals.css"; // estilos globales
import "./styles/index.css"; // si lo necesitas

// Opcional: si vas a usar íconos (Lucide, Heroicons, etc.)
// import './lib/icons';

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error('Root element not found. Make sure <div id="root"></div> exists in index.html');
}

// No hay router instalado a propósito (ver ResetPasswordPage.tsx) — un
// chequeo manual del pathname alcanza para las pocas rutas "especiales"
// que no son parte del ERP normal de un tenant. Estas páginas quedan
// FUERA de <AuthProvider>: no dependen de (ni deben tocar) la sesión de
// ningún tenant.
//
// Es un COMPONENTE (<RutaActual />) y no una función invocada como
// `{renderizarApp()}`, y la diferencia no es de estilo: invocarla dejaría
// su código corriendo al construir el árbol de elementos, o sea ANTES de
// que el ErrorBoundary renderice, y un error acá se escaparía del boundary
// dejando la pantalla en blanco igual que sin boundary. Como componente,
// React la ejecuta dentro del subárbol protegido. Comprobado con un error
// inyectado a propósito: con la invocación directa el fallback NO aparecía.
//
// El disable es porque main.tsx es el punto de entrada, no un módulo que
// Fast Refresh vaya a recargar en caliente: mover este componente a otro
// archivo solo para callar la regla separaría el ruteo de donde se usa sin
// ganar nada. Mismo criterio que el disable de AuthContext.tsx.
// eslint-disable-next-line react-refresh/only-export-components
function RutaActual() {
  if (window.location.pathname === "/reset-password") {
    return <ResetPasswordPage />;
  }

  if (window.location.pathname === "/plataforma") {
    return <PlatformApp />;
  }

  return (
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}

// El ErrorBoundary envuelve a las TRES rutas, no solo al ERP: un error de
// render en /reset-password o en el panel de plataforma deja la misma
// pantalla en blanco que uno en el ERP.
createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <RutaActual />
    </ErrorBoundary>
  </React.StrictMode>
);
