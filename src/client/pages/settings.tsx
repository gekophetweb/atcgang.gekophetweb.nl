import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { authClient, PROVIDER_LABELS } from "../lib/auth";
import { api } from "../lib/api";
import { useMe } from "../layout";
import { Button, Card, ErrorText, Input, Label, PageTitle } from "../ui";

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function Profile() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [name, setName] = useState(me?.name ?? "");
  const save = useMutation({
    mutationFn: async (patch: { name?: string; emailNotifications?: boolean }) => {
      const { error } = await authClient.updateUser(patch);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  if (!me) return null;
  return (
    <Card className="space-y-4">
      <h2 className="font-semibold">Profile</h2>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ name });
        }}
      >
        <div className="min-w-60 flex-1">
          <Label text="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Label>
        </div>
        <Button variant="primary" disabled={save.isPending}>
          Save
        </Button>
      </form>
      <p className="text-sm text-zinc-400">Email: {me.email}</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={me.emailNotifications}
          onChange={(e) => save.mutate({ emailNotifications: e.target.checked })}
        />
        Email me when someone tags me in photos (in-app notifications are always on)
      </label>
      <ErrorText error={save.error} />
    </Card>
  );
}

function SignInMethods() {
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: () => api.get<{ providers: string[] }>("/config") });
  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: async () => {
      const { data, error } = await authClient.listAccounts();
      if (error) throw new Error(error.message);
      return data;
    },
  });
  const unlink = useMutation({
    mutationFn: async (a: { providerId: string; accountId: string }) => {
      const { error } = await authClient.unlinkAccount(a);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
  const linked = new Set(accounts?.map((a) => a.providerId));
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Sign-in methods</h2>
      <p className="text-sm text-zinc-400">
        You can always sign in with a code sent to your email. Link other accounts to sign in with them too – also
        when they use a different email address (like Apple's "Hide My Email").
      </p>
      <ul className="divide-y divide-zinc-800">
        {accounts?.map((a) => (
          <li key={a.id} className="flex items-center justify-between py-2 text-sm">
            <span>{a.providerId === "credential" ? "Email" : (PROVIDER_LABELS[a.providerId] ?? a.providerId)}</span>
            {accounts.length > 1 && (
              <Button variant="ghost" onClick={() => unlink.mutate({ providerId: a.providerId, accountId: a.accountId })}>
                Unlink
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {config?.providers
          .filter((p) => !linked.has(p))
          .map((p) => (
            <Button key={p} onClick={() => authClient.linkSocial({ provider: p as "google", callbackURL: "/settings" })}>
              Link {PROVIDER_LABELS[p] ?? p}
            </Button>
          ))}
      </div>
      <ErrorText error={unlink.error} />
    </Card>
  );
}

function Storage() {
  const { data } = useQuery({ queryKey: ["usage"], queryFn: () => api.get<{ bytes: number; quota: number }>("/me/usage") });
  if (!data) return null;
  const pct = Math.min(100, (data.bytes / data.quota) * 100);
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold">Storage</h2>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm text-zinc-400">
        {formatBytes(data.bytes)} of {formatBytes(data.quota)} used by photos you uploaded.
      </p>
    </Card>
  );
}

interface McpConnection {
  id: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
}

function McpConnections() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["mcp-connections"], queryFn: () => api.get<McpConnection[]>("/mcp-connections") });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/mcp-connections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-connections"] }),
  });
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">AI connections (MCP)</h2>
      <p className="text-sm text-zinc-400">
        Connect Claude or another MCP client to <code className="text-zinc-200">{window.location.origin}/mcp</code>. You sign in here and
        approve access; no API keys needed.
      </p>
      {data?.length ? (
        <ul className="divide-y divide-zinc-800">
          {data.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span>
                {c.clientName} <span className="text-zinc-500">· since {new Date(c.createdAt).toLocaleDateString()}</span>
              </span>
              <Button variant="ghost" onClick={() => revoke.mutate(c.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-500">No connected clients.</p>
      )}
    </Card>
  );
}

function DangerZone() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState("");
  const del = useMutation({
    mutationFn: () => api.del("/me", { confirm: "DELETE" }),
    onSuccess: () => {
      qc.clear();
      navigate({ to: "/login" });
    },
  });
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Your data</h2>
      <p className="text-sm text-zinc-400">Download everything: concerts, people, labels and tags as JSON plus your photos, in one zip.</p>
      <a href="/api/export" className="inline-block rounded-lg bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700" download>
        Export all data
      </a>
      <hr className="border-zinc-800" />
      <p className="text-sm text-zinc-400">
        Delete your account: your photos and concerts are removed. Shared concerts you own pass to another member. Backups roll
        off within 14 days.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-48" placeholder='Type "DELETE"' value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <Button variant="danger" disabled={confirm !== "DELETE" || del.isPending} onClick={() => del.mutate()}>
          Delete my account
        </Button>
      </div>
      <ErrorText error={del.error} />
    </Card>
  );
}

export function SettingsPage() {
  return (
    <div className="space-y-4">
      <PageTitle>Settings</PageTitle>
      <Profile />
      <SignInMethods />
      <Storage />
      <McpConnections />
      <DangerZone />
    </div>
  );
}
