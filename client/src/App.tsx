import { useEffect } from 'react';
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { useAuthStore } from '@abyss/shared';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import QuickJoinPage from './pages/QuickJoinPage';
import MainLayout from './pages/MainLayout';
import ToastHost from './components/ToastHost';
import ScreenSharePicker from './components/ScreenSharePicker';
import { useWindowVisibility } from './hooks/useWindowVisibility';
import { useIdleDetection } from './hooks/useIdleDetection';
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
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const initialized = useAuthStore((s) => s.initialized);
  const isWindowVisible = useWindowVisibility();
  useIdleDetection();

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Check for OTA updates after auth init on native platforms
  useEffect(() => {
    if (!initialized || !Capacitor.isNativePlatform()) return;

    import('./services/otaUpdater').then(({ checkForOtaUpdate }) => {
      checkForOtaUpdate();
    });
  }, [initialized]);

  // Register/unregister push token based on auth state
  useEffect(() => {
    if (!initialized || !Capacitor.isNativePlatform()) return;

    if (isAuthenticated) {
      import('./services/pushNotifications').then(({ registerForPushNotifications }) => {
        registerForPushNotifications();
      });
    }

    return () => {
      if (isAuthenticated) {
        import('./services/pushNotifications').then(({ unregisterPushToken }) => {
          unregisterPushToken();
        });
      }
    };
  }, [isAuthenticated, initialized]);

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
        <Route path="/join/:code" element={<QuickJoinPage />} />
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
