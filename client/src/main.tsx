// client/src/main.tsx
import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
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
function renderizarApp() {
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

createRoot(rootElement).render(<React.StrictMode>{renderizarApp()}</React.StrictMode>);
