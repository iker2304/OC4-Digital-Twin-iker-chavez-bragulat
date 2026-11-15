import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { DashboardLayout } from './components/layout/DashboardLayout';
import { useAuthStore } from './store/authStore';
import Twin from './pages/Twin';
import Home from './pages/Home';
import Settings from './pages/Settings';
import Grafana from './pages/Grafana';
import MobileCamera from './pages/MobileCamera';
import DatasetGeneration from './pages/DatasetGeneration';
import MapPage from './pages/MapPage';
import SHMPage from './pages/SHMPage';
import LoginPage from './pages/LoginPage';
import ProfilesPage from './pages/ProfilesPage';
import ProfileDetailPage from './pages/ProfileDetailPage';
import FEMPage from './pages/FEMPage';
import { TrainingPage } from './pages/TrainingPage';

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function App() {
  const { loadSession, isAuthenticated, isInitializing } = useAuthStore();

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  if (isInitializing) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-zinc-50 dark:bg-[#0c0c0e]">
        <div className="mb-3 h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-900 dark:border-zinc-700 dark:border-t-zinc-100" />
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Sincronizando con el servidor…</p>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={
          isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />
        } />
        <Route path="/mobile-camera" element={<MobileCamera />} />
        <Route path="*" element={
          <AuthGuard>
            <DashboardLayout>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/twin" element={<Twin />} />
                <Route path="/map" element={<MapPage />} />
                <Route path="/shm" element={<SHMPage />} />
                <Route path="/profiles" element={<ProfilesPage />} />
                <Route path="/profiles/:profileId" element={<ProfileDetailPage />} />
                <Route path="/training" element={<TrainingPage />} />
                <Route path="/dataset" element={<DatasetGeneration />} />
                <Route path="/fem" element={<FEMPage />} />
                <Route path="/grafana" element={<Grafana />} />
                <Route path="/settings" element={<Settings />} />
              </Routes>
            </DashboardLayout>
          </AuthGuard>
        } />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
