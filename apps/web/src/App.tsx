import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { Layout } from '@/components/Layout';
import { Spinner } from '@/components/ui';
import { LoginPage } from '@/features/auth/LoginPage';
import { SetupPage } from '@/features/auth/SetupPage';
import { ChangePasswordPage } from '@/features/auth/ChangePasswordPage';

// Carga diferida por ruta. El panel va tambien en diferido a proposito: es la
// unica pagina que usa uPlot, y con importacion estatica la libreria de
// graficas entraria en el bundle inicial, es decir, la descargaria tambien
// quien solo ve la pantalla de login.
const DashboardPage = lazy(() =>
  import('@/features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const ContainersPage = lazy(() =>
  import('@/features/containers/ContainersPage').then((m) => ({ default: m.ContainersPage })),
);
const ImagesPage = lazy(() =>
  import('@/features/images/ImagesPage').then((m) => ({ default: m.ImagesPage })),
);
const ProjectsPage = lazy(() =>
  import('@/features/projects/ProjectsPage').then((m) => ({ default: m.ProjectsPage })),
);
const UpdatesPage = lazy(() =>
  import('@/features/updates/UpdatesPage').then((m) => ({ default: m.UpdatesPage })),
);
const SettingsPage = lazy(() =>
  import('@/features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

function FullscreenSpinner(): ReactNode {
  return (
    <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
      <Spinner className="size-6" />
    </div>
  );
}

export function App(): ReactNode {
  const { user, loading, needsSetup } = useAuth();

  if (loading) return <FullscreenSpinner />;
  if (needsSetup) return <SetupPage />;
  if (!user) return <LoginPage />;

  // Hasta que no cambie la contrasena inicial no se muestra nada mas: el
  // servidor rechaza el resto de rutas de todas formas.
  if (user.mustChangePassword) return <ChangePasswordPage forced />;

  return (
    <Layout>
      <Suspense fallback={<FullscreenSpinner />}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/containers" element={<ContainersPage />} />
          <Route path="/images" element={<ImagesPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/updates" element={<UpdatesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
