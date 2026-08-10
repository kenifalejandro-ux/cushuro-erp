// client/src/components/layout/Sidebar.tsx
import { useAuth } from "../../context/AuthContext";
import { MODULOS_CLIENTE } from "../../modules/registry";

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: any) => void;
}

export default function Sidebar({ activeTab, setActiveTab }: SidebarProps) {
  const { usuario } = useAuth();
  // Qué pestañas ve cada quien lo decide el panel de plataforma (módulos
  // por empresa + por usuario) — ver modulosPermitidos en el JWT. La
  // lista de módulos posibles viene del registry (ver
  // docs/adr/0002-contrato-de-modulo.md), no de un array hardcodeado acá.
  const tabs = MODULOS_CLIENTE.filter((modulo) => usuario?.modulosPermitidos.includes(modulo.id));

  return (
    <aside className="w-64 bg-white border-r min-h-[calc(100vh-73px)] p-6">
      <nav className="space-y-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`w-full text-left px-4 py-3 rounded-xl flex items-center gap-3 transition-colors ${
              activeTab === tab.id
                ? "bg-blue-50 text-blue-700 font-medium"
                : "hover:bg-gray-100 text-gray-700"
            }`}
          >
            <span>{tab.icono}</span>
            {tab.label}
          </button>
        ))}
        {/* Facturación no es un módulo del registry (no se activa/
            desactiva por tenant) -- visible siempre, para cualquier
            usuario autenticado. */}
        <button
          onClick={() => setActiveTab("facturacion")}
          className={`w-full text-left px-4 py-3 rounded-xl flex items-center gap-3 transition-colors ${
            activeTab === "facturacion"
              ? "bg-blue-50 text-blue-700 font-medium"
              : "hover:bg-gray-100 text-gray-700"
          }`}
        >
          <span>🧾</span>
          Facturación
        </button>
      </nav>
    </aside>
  );
}
