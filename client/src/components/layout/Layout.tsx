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
    <div className="min-h-screen bg-slate-50 text-[#0A1014] font-sans">
      <Header onIrACombustible={() => setActiveTab("combustible")} />
      <EstadoOffline />

      <div className="flex">
        <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />

        <main className="flex-1 p-8 overflow-auto h-[calc(100vh-66px)]">
          <div className="max-w-7xl mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}
