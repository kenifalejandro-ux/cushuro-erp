// client/src/components/layout/Sidebar.tsx
import { useAuth } from '../../context/AuthContext';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: any) => void;
}

const TODAS_LAS_PESTAÑAS = [
  { id: 'dashboard', label: '📊 Dashboard', icon: '📊' },
  { id: 'repuestos', label: '🔧 Repuestos', icon: '🔧' },
  { id: 'combustible', label: '⛽ Combustible', icon: '⛽' },
  { id: 'documentos', label: '📄 Documentos', icon: '📄' },
];

export default function Sidebar({ activeTab, setActiveTab }: SidebarProps) {
  const { usuario } = useAuth();
  // Qué pestañas ve cada quien lo decide el panel de plataforma (módulos
  // por empresa + por usuario) — ver modulosPermitidos en el JWT.
  const tabs = TODAS_LAS_PESTAÑAS.filter((tab) => usuario?.modulosPermitidos.includes(tab.id));

  return (
    <aside className="w-64 bg-white border-r min-h-[calc(100vh-73px)] p-6">
      <nav className="space-y-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`w-full text-left px-4 py-3 rounded-xl flex items-center gap-3 transition-colors ${
              activeTab === tab.id 
                ? 'bg-blue-50 text-blue-700 font-medium' 
                : 'hover:bg-gray-100 text-gray-700'
            }`}
          >
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}