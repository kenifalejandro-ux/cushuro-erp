// client/src/App.tsx
import { useState, useEffect } from 'react';
import Layout from './components/layout/Layout';
import Dashboard from './components/dashboard/Dashboard';
import RepuestosTable from './components/repuestos/RepuestosTable';
import CombustiblePanel from './components/combustible/CombustiblePanel';
import DocumentosTable from './components/documentos/DocumentosTable';

function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'repuestos' | 'combustible' | 'documentos'>('dashboard');
  const [loading, setLoading] = useState(true);

  // Simulación de carga para evitar pantalla negra
  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 800);
    return () => clearTimeout(timer);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-white text-xl">Cargando Cushuro ERP...</div>
      </div>
    );
  }

  return (
    <Layout activeTab={activeTab} setActiveTab={setActiveTab}>
      {activeTab === 'dashboard' && <Dashboard />}
      {activeTab === 'repuestos' && <RepuestosTable />}
      {activeTab === 'combustible' && <CombustiblePanel />}
      {activeTab === 'documentos' && <DocumentosTable />}
    </Layout>
  );
}

export default App;