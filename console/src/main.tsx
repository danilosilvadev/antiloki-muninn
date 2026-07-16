import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Shell } from './shell';
import { DashboardPage } from './pages/dashboard';
import { LeadsPage } from './pages/leads';
import { ReviewPage } from './pages/review';
import { ControlPage } from './pages/control';
import { WaitlistPage } from './pages/waitlist';
import { SettingsPage } from './pages/settings';
import './theme.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
});

const rootRoute = createRootRoute({ component: Shell });
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: DashboardPage });
const leadsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/leads', component: LeadsPage });
const reviewRoute = createRoute({ getParentRoute: () => rootRoute, path: '/review', component: ReviewPage });
const controlRoute = createRoute({ getParentRoute: () => rootRoute, path: '/control', component: ControlPage });
const waitlistRoute = createRoute({ getParentRoute: () => rootRoute, path: '/waitlist', component: WaitlistPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage });

const routeTree = rootRoute.addChildren([dashboardRoute, leadsRoute, reviewRoute, controlRoute, waitlistRoute, settingsRoute]);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
