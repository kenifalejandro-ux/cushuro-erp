// client/src/App.tsx
import { Suspense, lazy, useState } from "react";

import Layout from "./components/layout/Layout";
import { useAuth } from "./context/AuthContext";
import { MODULOS_CLIENTE } from "./modules/registry";
import CambiarPasswordObligatoria from "./pages/CambiarPasswordObligatoria";
import LoginPage from "./pages/LoginPage";

// Facturación no es un módulo del registry (ver Sidebar.tsx) -- se resuelve
// aparte, no vía MODULOS_CLIENTE.find().
const FacturacionView = lazy(() => import("./components/facturacion/FacturacionView"));

function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const { usuario, cargando, estaAutenticado, login } = useAuth();

  if (cargando) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-white text-xl">Cargando MinCore ERP...</div>
      </div>
    );
  }

  if (!estaAutenticado) {
    return <LoginPage />;
  }

  if (usuario!.debeCambiarPassword) {
    // Actualiza el usuario en memoria en vez de re-pedir /api/auth/me: el
    // JWT actual seguiría diciendo `true` hasta el próximo login/refresh
    // (ver el comentario de cambiarMiPasswordApi en services/authApi.ts).
    return (
      <CambiarPasswordObligatoria
        onListo={() => login({ ...usuario!, debeCambiarPassword: false })}
      />
    );
  }

  // El componente de cada módulo viaja al navegador recién cuando se abre
  // (React.lazy, ver modules/registry.tsx) — agregar un módulo nuevo no
  // infla el chunk inicial de los que ya existen.
  const moduloActivo = MODULOS_CLIENTE.find((m) => m.id === activeTab);
  const ComponenteActivo = activeTab === "facturacion" ? FacturacionView : moduloActivo?.componente;

  return (
    <Layout activeTab={activeTab} setActiveTab={setActiveTab}>
      <Suspense fallback={<div className="p-20 text-center text-slate-500">Cargando...</div>}>
        {ComponenteActivo && <ComponenteActivo />}
      </Suspense>
    </Layout>
  );
}

export default App;
