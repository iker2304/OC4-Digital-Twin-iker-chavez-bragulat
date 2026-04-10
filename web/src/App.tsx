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
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-gray-50 dark:bg-slate-900">
        <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
        <p className="text-gray-500 dark:text-gray-400 font-medium animate-pulse">Sincronizando con el servidor...</p>
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
                <Route path="/settings" element={<Settings />} />
                <Route path="/grafana" element={<Grafana />} />
                <Route path="/dataset" element={<DatasetGeneration />} />
              </Routes>
            </DashboardLayout>
          </AuthGuard>
        } />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
