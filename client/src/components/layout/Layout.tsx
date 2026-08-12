// client/src/components/layout/Layout.tsx
import EstadoOffline from "./EstadoOffline";
import Header from "./Header";
import Sidebar from "./Sidebar";

interface LayoutProps {
  activeTab: string;
  setActiveTab: (tab: any) => void;
  children: React.ReactNode;
}

export default function Layout({ activeTab, setActiveTab, children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      {/* Debajo del Header (que es sticky) y encima de todo el contenido:
          el aviso de "sin conexión" tiene que verse desde cualquier
          módulo, no solo desde el que encoló algo. */}
      <EstadoOffline />
      <div className="flex">
        <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
        <main className="flex-1 p-8 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
