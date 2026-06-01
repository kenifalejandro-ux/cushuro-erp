// client/src/components/layout/Sidebar.tsx

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: any) => void;
}

export default function Sidebar({ activeTab, setActiveTab }: SidebarProps) {
  const tabs = [
    { id: 'dashboard', label: '📊 Dashboard', icon: '📊' },
    { id: 'repuestos', label: '🔧 Repuestos', icon: '🔧' },
    { id: 'combustible', label: '⛽ Combustible', icon: '⛽' },
    { id: 'documentos', label: '📄 Documentos', icon: '📄' },
  ];

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