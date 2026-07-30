// client/src/App.tsx
import { useState } from 'react';
import Layout from './components/layout/Layout';
import Dashboard from './components/dashboard/Dashboard';
import RepuestosTable from './components/repuestos/RepuestosTable';
import CombustiblePanel from './components/combustible/CombustiblePanel';
import DocumentosTable from './components/documentos/DocumentosTable';
import LoginPage from './pages/LoginPage';
import { useAuth } from './context/AuthContext';

function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'repuestos' | 'combustible' | 'documentos'>('dashboard');
  const { cargando, estaAutenticado } = useAuth();

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