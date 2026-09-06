import './styles/globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { ThreadPage } from './routes/index';
import { DiffPage } from './routes/diff';
import { FilesPage } from './routes/files';
import { PrListPage, PrViewerPage } from './routes/prs';

function Shell() {
  return (
    <div>
      <nav aria-label="Sections">
        <Link to="/">Thread</Link>
        <Link to="/diff">Diff</Link>
        <Link to="/prs">PRs</Link>
        <Link to="/files">Files</Link>
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Shell });

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: ThreadPage,
});

const diffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/diff',
  component: DiffPage,
});

const prsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/prs',
  component: PrListPage,
});

const prViewerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/prs/$n',
  component: PrViewerPage,
});

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/files',
  component: FilesPage,
});

const routeTree = rootRoute.addChildren([
  threadRoute,
  diffRoute,
  prsRoute,
  prViewerRoute,
  filesRoute,
]);

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('pi-do: missing #root element');
createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
