import { useEffect } from 'react';
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from '@abyss/shared';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import MainLayout from './pages/MainLayout';
import ToastHost from './components/ToastHost';
import ScreenSharePicker from './components/ScreenSharePicker';
import { useWindowVisibility } from './hooks/useWindowVisibility';
import './App.css';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const initialized = useAuthStore((s) => s.initialized);
  if (!initialized) {
    return (
      <div className="app-loading">
        <div className="app-loading-card">
          <div className="app-loading-spinner" />
          <div className="app-loading-text">Loading Abyss</div>
        </div>
      </div>
    );
  }
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" />;
}

function App() {
  const initialize = useAuthStore((s) => s.initialize);
  const isWindowVisible = useWindowVisibility();

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Pause all animations globally when window is not visible
  useEffect(() => {
    if (isWindowVisible) {
      document.body.classList.remove('window-hidden');
    } else {
      document.body.classList.add('window-hidden');
    }
  }, [isWindowVisible]);

  const Router = window.electron ? HashRouter : BrowserRouter;

  return (
    <Router>
      <ToastHost />
      {window.electron && <ScreenSharePicker />}
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <MainLayout />
            </ProtectedRoute>
          }
        />
      </Routes>
    </Router>
  );
}

export default App;
