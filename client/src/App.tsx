import { useEffect } from 'react';
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { useAuthStore, onBeforeLogout } from '@abyss/shared';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
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

  // Register push token and set up pre-logout cleanup
  useEffect(() => {
    if (!initialized || !Capacitor.isNativePlatform() || !isAuthenticated) return;

    let unsubscribe: (() => void) | undefined;

    import('./services/pushNotifications').then(({ registerForPushNotifications, unregisterPushToken }) => {
      registerForPushNotifications();
      // Register cleanup to run BEFORE auth is cleared so the API call succeeds
      unsubscribe = onBeforeLogout(() => unregisterPushToken());
    });

    return () => { unsubscribe?.(); };
  }, [isAuthenticated, initialized]);

  // Suspend SignalR when the mobile app backgrounds so the server sees the user
  // as offline and delivers push notifications via FCM instead of relying on the
  // (suspended) WebView to process SignalR signals.  A 5-second grace period
  // avoids unnecessary disconnects for quick app switches (copying a link, etc.).
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !isAuthenticated) return;

    let cleanup: (() => Promise<void>) | undefined;
    let suspendTimer: ReturnType<typeof setTimeout> | null = null;

    import('@capacitor/app').then(({ App }) => {
      const handle = App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          // Cancel pending suspend if user returned quickly
          if (suspendTimer) {
            clearTimeout(suspendTimer);
            suspendTimer = null;
          }
          import('@abyss/shared').then(({ startConnection }) => {
            startConnection();
          });
        } else {
          suspendTimer = setTimeout(() => {
            suspendTimer = null;
            import('@abyss/shared').then(({ suspendConnection }) => {
              suspendConnection();
            });
          }, 5_000);
        }
      });
      cleanup = async () => (await handle).remove();
    });

    return () => {
      if (suspendTimer) clearTimeout(suspendTimer);
      cleanup?.();
    };
  }, [isAuthenticated]);

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
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
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
