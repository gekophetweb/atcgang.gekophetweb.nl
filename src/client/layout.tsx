import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./lib/api";
import { authClient } from "./lib/auth";
import { Avatar, cx } from "./ui";

export interface Me {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  role: "user" | "admin";
  emailNotifications: boolean;
}

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return (await api.get<{ user: Me }>("/me")).user;
      } catch {
        return null;
      }
    },
    staleTime: 60_000,
  });
}

const nav = [
  { to: "/", label: "Concerts" },
  { to: "/calendar", label: "Calendar" },
  { to: "/memories", label: "Memories" },
  { to: "/photos", label: "Photos" },
  { to: "/photos/me", label: "Photos of me" },
  { to: "/people", label: "People & labels" },
] as const;

function Bell() {
  const { data } = useQuery({
    queryKey: ["notifications", "count"],
    queryFn: () => api.get<{ unread: number }>("/notifications/unread-count"),
    refetchInterval: 60_000,
  });
  const unread = data?.unread ?? 0;
  return (
    <Link to="/notifications" className="relative rounded-lg p-2 hover:bg-zinc-800" aria-label={`Notifications (${unread} unread)`}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold text-zinc-950">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}

export function Layout({ me, children }: { me: Me; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

  async function signOut() {
    await authClient.signOut();
    qc.clear();
    navigate({ to: "/login" });
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2">
          <button className="rounded-lg p-2 hover:bg-zinc-800 md:hidden" onClick={() => setOpen(!open)} aria-label="Menu" aria-expanded={open}>
            ☰
          </button>
          <Link to="/" className="mr-4 flex items-center gap-2 font-bold">
            <img src="/icon.svg" alt="" width={24} height={24} /> ATC Gang
          </Link>
          <nav className="hidden gap-1 md:flex" aria-label="Main">
            {nav.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                activeOptions={{ exact: true }}
                className="rounded-lg px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 [&.active]:bg-zinc-800 [&.active]:text-white"
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            {me.role === "admin" && (
              <Link to="/admin" className="hidden rounded-lg px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 md:block [&.active]:bg-zinc-800">
                Admin
              </Link>
            )}
            <Bell />
            <Link to="/settings" className="rounded-lg p-1 hover:bg-zinc-800" aria-label="Settings">
              <Avatar name={me.name || me.email} src={me.image} />
            </Link>
          </div>
        </div>
        <nav className={cx("border-t border-zinc-800 px-4 py-2 md:hidden", !open && "hidden")} aria-label="Mobile">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2 text-zinc-300 [&.active]:bg-zinc-800">
              {n.label}
            </Link>
          ))}
          <Link to="/settings" onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2 text-zinc-300">
            Settings
          </Link>
          {me.role === "admin" && (
            <Link to="/admin" onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2 text-zinc-300">
              Admin
            </Link>
          )}
          <button onClick={signOut} className="block w-full rounded-lg px-3 py-2 text-left text-zinc-300">
            Sign out
          </button>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      <footer className="mx-auto flex max-w-6xl flex-wrap gap-4 px-4 py-8 text-xs text-zinc-500">
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        {me.role === "admin" && <Link to="/admin">Admin</Link>}
        <button onClick={signOut} className="ml-auto underline">
          Sign out
        </button>
      </footer>
    </div>
  );
}
