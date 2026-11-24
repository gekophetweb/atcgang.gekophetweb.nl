import { useEffect } from "react";
import { createRootRoute, createRoute, createRouter, Outlet, useNavigate } from "@tanstack/react-router";
import { Layout, useMe } from "./layout";
import { Spinner } from "./ui";
import { LoginPage } from "./pages/login";
import { ConcertsPage } from "./pages/concerts";
import { CalendarPage } from "./pages/calendar";
import { ConcertPage } from "./pages/concert";
import { MemoriesPage } from "./pages/memories";
import { PhotosPage } from "./pages/photos";
import { PeoplePage } from "./pages/people";
import { SettingsPage } from "./pages/settings";
import { NotificationsPage } from "./pages/notifications";
import { AdminPage } from "./pages/admin";
import { InvitePage } from "./pages/invite";
import { ConsentPage } from "./pages/consent";
import { PrivacyPage, TermsPage } from "./pages/legal";

function Authed() {
  const { data: me, isLoading, isFetching } = useMe();
  const navigate = useNavigate();
  const signedOut = !isFetching && !me;
  useEffect(() => {
    if (!signedOut) return;
    const here = window.location.pathname + window.location.search;
    navigate({ to: "/login", search: here === "/" ? {} : { redirect: here }, replace: true });
  }, [signedOut, navigate]);
  if (isLoading || !me)
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  return (
    <Layout me={me}>
      <Outlet />
    </Layout>
  );
}

const root = createRootRoute({ component: Outlet });
const login = createRoute({ getParentRoute: () => root, path: "/login", component: LoginPage });
const privacy = createRoute({ getParentRoute: () => root, path: "/privacy", component: PrivacyPage });
const terms = createRoute({ getParentRoute: () => root, path: "/terms", component: TermsPage });
const app = createRoute({ getParentRoute: () => root, id: "app", component: Authed });

const r0 = createRoute({ getParentRoute: () => app, path: "/", component: ConcertsPage });
const r1 = createRoute({ getParentRoute: () => app, path: "/calendar", component: CalendarPage });
const r2 = createRoute({ getParentRoute: () => app, path: "/concerts/$id", component: ConcertPage });
const r3 = createRoute({ getParentRoute: () => app, path: "/memories", component: MemoriesPage });
const r4 = createRoute({ getParentRoute: () => app, path: "/photos", component: () => <PhotosPage /> });
const r5 = createRoute({ getParentRoute: () => app, path: "/photos/me", component: () => <PhotosPage me /> });
const r6 = createRoute({ getParentRoute: () => app, path: "/people", component: PeoplePage });
const r7 = createRoute({ getParentRoute: () => app, path: "/settings", component: SettingsPage });
const r8 = createRoute({ getParentRoute: () => app, path: "/notifications", component: NotificationsPage });
const r9 = createRoute({ getParentRoute: () => app, path: "/admin", component: AdminPage });
const r10 = createRoute({ getParentRoute: () => app, path: "/invite/$token", component: InvitePage });
const r11 = createRoute({ getParentRoute: () => app, path: "/consent", component: ConsentPage });

const routeTree = root.addChildren([login, privacy, terms, app.addChildren([r0, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11])]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
