import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useMe } from "../layout";
import { formatBytes } from "./settings";
import { Button, Card, cx, ErrorText, Input, Label, PageTitle, Select, Spinner } from "../ui";

interface Overview {
  users: { id: string; email: string; name: string; role: "user" | "admin"; disabled: boolean; createdAt: string; bytes: number; photos: number; concerts: number }[];
  totals: { users: number; photoBytes: number; signupsLast7Days: number };
  disk: { total: number; free: number; usedPercent: number | null; alert: boolean } | null;
}

type Flags<T extends string> = { [K in `${T}Set`]?: boolean };
interface MailView extends Flags<"resendApiKey" | "mailgunApiKey" | "smtpPassword"> {
  provider: "console" | "resend" | "mailgun" | "smtp";
  from: string;
  mailgunDomain?: string;
  mailgunRegion: "us" | "eu";
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
}
interface SsoView extends Flags<"clientSecret" | "privateKey"> {
  enabled: boolean;
  ready: boolean;
  clientId?: string;
  teamId?: string;
  keyId?: string;
}
interface SettingsView {
  mail: MailView;
  sso: Record<"google" | "microsoft" | "apple" | "github", SsoView>;
  callbackUrls: Record<string, string>;
}

function Users() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data, isLoading } = useQuery({ queryKey: ["admin"], queryFn: () => api.get<Overview>("/admin/overview") });
  const update = useMutation({
    mutationFn: (v: { id: string; disabled?: boolean; role?: string }) => api.patch(`/admin/users/${v.id}`, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }),
  });
  if (isLoading || !data) return <Spinner />;
  return (
    <div className="space-y-4">
      {data.disk?.alert && (
        <p role="alert" className="rounded-lg bg-red-900/40 p-3 text-sm text-red-200">
          The photo disk is {data.disk.usedPercent}% full – make room or move photos to other storage.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <p className="text-2xl font-bold">{data.totals.users}</p>
          <p className="text-sm text-zinc-400">Users</p>
        </Card>
        <Card>
          <p className="text-2xl font-bold">{data.totals.signupsLast7Days}</p>
          <p className="text-sm text-zinc-400">Sign-ups last 7 days</p>
        </Card>
        <Card>
          <p className="text-2xl font-bold">{formatBytes(data.totals.photoBytes)}</p>
          <p className="text-sm text-zinc-400">Photos stored</p>
        </Card>
        <Card>
          <p className="text-2xl font-bold">{data.disk ? `${data.disk.usedPercent}%` : "–"}</p>
          <p className="text-sm text-zinc-400">{data.disk ? `Disk used · ${formatBytes(data.disk.free)} free` : "Disk unknown"}</p>
        </Card>
      </div>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-zinc-500">
            <tr>
              <th className="p-3">User</th>
              <th className="p-3">Joined</th>
              <th className="p-3 text-right">Concerts</th>
              <th className="p-3 text-right">Photos</th>
              <th className="p-3">Role</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {data.users.map((u) => (
              <tr key={u.id} className={cx(u.disabled && "opacity-50")}>
                <td className="p-3">
                  <div className="font-medium">{u.name}</div>
                  <div className="text-zinc-500">{u.email}</div>
                </td>
                <td className="p-3 text-zinc-400">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td className="p-3 text-right tabular-nums">{u.concerts}</td>
                <td className="p-3 text-right tabular-nums">
                  {u.photos} <span className="text-zinc-500">({formatBytes(u.bytes)})</span>
                </td>
                <td className="p-3">
                  <Select
                    className="w-auto"
                    value={u.role}
                    disabled={u.id === me?.id}
                    onChange={(e) => update.mutate({ id: u.id, role: e.target.value })}
                    aria-label={`Role of ${u.email}`}
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </Select>
                </td>
                <td className="p-3 text-right">
                  {u.id !== me?.id && (
                    <Button variant={u.disabled ? "secondary" : "ghost"} onClick={() => update.mutate({ id: u.id, disabled: !u.disabled })}>
                      {u.disabled ? "Enable" : "Disable"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <ErrorText error={update.error} />
    </div>
  );
}

function SecretInput({ isSet, value, onChange, label, multiline }: { isSet?: boolean; value: string; onChange: (v: string) => void; label: string; multiline?: boolean }) {
  const placeholder = isSet ? "•••••••• (saved – leave empty to keep)" : "Not set";
  return (
    <Label text={label}>
      {multiline ? (
        <textarea
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs"
          rows={4}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
        />
      ) : (
        <Input type="password" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" />
      )}
    </Label>
  );
}

function MailSettings({ view }: { view: MailView }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ ...view, resendApiKey: "", mailgunApiKey: "", smtpPassword: "" });
  useEffect(() => setF({ ...view, resendApiKey: "", mailgunApiKey: "", smtpPassword: "" }), [view]);
  const save = useMutation({
    mutationFn: () => api.put<SettingsView>("/admin/settings/mail", f),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-settings"] }),
  });
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; to: string }>("/admin/settings/mail/test") });
  const set = (k: keyof typeof f) => (v: string | boolean | number) => setF({ ...f, [k]: v });

  return (
    <Card className="space-y-4">
      <h2 className="font-semibold">Mail</h2>
      <p className="text-sm text-zinc-400">Used for login codes, invites and tag notifications. Set up SPF/DKIM/DMARC for the sending domain.</p>
      <form
        className="grid gap-3 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Label text="Provider">
          <Select value={f.provider} onChange={(e) => set("provider")(e.target.value)}>
            <option value="console">None (write to server log)</option>
            <option value="resend">Resend</option>
            <option value="mailgun">Mailgun</option>
            <option value="smtp">SMTP</option>
          </Select>
        </Label>
        <Label text="From">
          <Input value={f.from} onChange={(e) => set("from")(e.target.value)} placeholder="ATC Gang <noreply@example.com>" required />
        </Label>
        {f.provider === "resend" && <SecretInput label="Resend API key" isSet={view.resendApiKeySet} value={f.resendApiKey} onChange={set("resendApiKey")} />}
        {f.provider === "mailgun" && (
          <>
            <SecretInput label="Mailgun API key" isSet={view.mailgunApiKeySet} value={f.mailgunApiKey} onChange={set("mailgunApiKey")} />
            <Label text="Sending domain">
              <Input value={f.mailgunDomain ?? ""} onChange={(e) => set("mailgunDomain")(e.target.value)} placeholder="mg.example.com" />
            </Label>
            <Label text="Region">
              <Select value={f.mailgunRegion} onChange={(e) => set("mailgunRegion")(e.target.value)}>
                <option value="eu">EU</option>
                <option value="us">US</option>
              </Select>
            </Label>
          </>
        )}
        {f.provider === "smtp" && (
          <>
            <Label text="Host">
              <Input value={f.smtpHost ?? ""} onChange={(e) => set("smtpHost")(e.target.value)} placeholder="smtp.example.com" />
            </Label>
            <Label text="Port">
              <Input type="number" value={f.smtpPort} onChange={(e) => set("smtpPort")(Number(e.target.value))} />
            </Label>
            <Label text="Username">
              <Input value={f.smtpUser ?? ""} onChange={(e) => set("smtpUser")(e.target.value)} autoComplete="off" />
            </Label>
            <SecretInput label="Password" isSet={view.smtpPasswordSet} value={f.smtpPassword} onChange={set("smtpPassword")} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.smtpSecure} onChange={(e) => set("smtpSecure")(e.target.checked)} /> Use TLS from the start (port 465)
            </label>
          </>
        )}
        <div className="flex flex-wrap items-center gap-2 md:col-span-2">
          <Button variant="primary" disabled={save.isPending}>
            Save mail settings
          </Button>
          <Button type="button" onClick={() => test.mutate()} disabled={test.isPending}>
            Send test email
          </Button>
          {save.isSuccess && <span className="text-sm text-green-400">Saved.</span>}
          {test.data?.ok && <span className="text-sm text-green-400">Sent to {test.data.to}.</span>}
        </div>
      </form>
      <ErrorText error={save.error ?? test.error} />
    </Card>
  );
}

const SSO_LABELS = { google: "Google", microsoft: "Microsoft (personal + work, tenant common)", apple: "Apple", github: "GitHub (OAuth App, scope user:email)" } as const;
type SsoKey = keyof typeof SSO_LABELS;

function SsoSettings({ view, callbackUrls }: { view: SettingsView["sso"]; callbackUrls: Record<string, string> }) {
  const qc = useQueryClient();
  const blank = () =>
    Object.fromEntries(
      (Object.keys(SSO_LABELS) as SsoKey[]).map((p) => [p, { enabled: view[p].enabled, clientId: view[p].clientId ?? "", clientSecret: "", teamId: view[p].teamId ?? "", keyId: view[p].keyId ?? "", privateKey: "" }]),
    ) as Record<SsoKey, { enabled: boolean; clientId: string; clientSecret: string; teamId: string; keyId: string; privateKey: string }>;
  const [f, setF] = useState(blank);
   
  useEffect(() => setF(blank()), [view]);
  const save = useMutation({
    mutationFn: () => api.put<SettingsView & { providers: string[] }>("/admin/settings/sso", f),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-settings"] });
      qc.invalidateQueries({ queryKey: ["config"] });
    },
  });
  const set = (p: SsoKey, k: keyof (typeof f)[SsoKey]) => (v: string | boolean) => setF({ ...f, [p]: { ...f[p], [k]: v } });

  return (
    <Card className="space-y-4">
      <h2 className="font-semibold">Sign-in with SSO</h2>
      <p className="text-sm text-zinc-400">Changes apply right away. Register each app with the callback URL shown.</p>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {(Object.keys(SSO_LABELS) as SsoKey[]).map((p) => (
          <fieldset key={p} className="space-y-3 rounded-lg border border-zinc-800 p-3">
            <legend className="flex items-center gap-2 px-1 text-sm font-medium">
              <input type="checkbox" checked={f[p].enabled} onChange={(e) => set(p, "enabled")(e.target.checked)} aria-label={`Enable ${p}`} />
              {SSO_LABELS[p]}
              {view[p].ready ? <span className="text-xs text-green-400">active</span> : f[p].enabled && <span className="text-xs text-amber-400">incomplete</span>}
            </legend>
            <p className="break-all text-xs text-zinc-500">
              Callback: <code>{callbackUrls[p]}</code>
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <Label text={p === "apple" ? "Services ID" : "Client ID"}>
                <Input value={f[p].clientId} onChange={(e) => set(p, "clientId")(e.target.value)} autoComplete="off" />
              </Label>
              {p === "apple" ? (
                <>
                  <Label text="Team ID">
                    <Input value={f[p].teamId} onChange={(e) => set(p, "teamId")(e.target.value)} />
                  </Label>
                  <Label text="Key ID">
                    <Input value={f[p].keyId} onChange={(e) => set(p, "keyId")(e.target.value)} />
                  </Label>
                  <SecretInput label="Private key (.p8)" multiline isSet={view[p].privateKeySet} value={f[p].privateKey} onChange={set(p, "privateKey")} />
                </>
              ) : (
                <SecretInput label="Client secret" isSet={view[p].clientSecretSet} value={f[p].clientSecret} onChange={set(p, "clientSecret")} />
              )}
            </div>
          </fieldset>
        ))}
        <Button variant="primary" disabled={save.isPending}>
          Save SSO settings
        </Button>
        {save.isSuccess && <span className="ml-2 text-sm text-green-400">Saved. Active: {save.data.providers.join(", ") || "none"}.</span>}
      </form>
      <ErrorText error={save.error} />
    </Card>
  );
}

function SiteSettings() {
  const { data, isLoading } = useQuery({ queryKey: ["admin-settings"], queryFn: () => api.get<SettingsView>("/admin/settings") });
  if (isLoading || !data) return <Spinner />;
  return (
    <div className="space-y-4">
      <MailSettings view={data.mail} />
      <SsoSettings view={data.sso} callbackUrls={data.callbackUrls} />
    </div>
  );
}

export function AdminPage() {
  const { data: me } = useMe();
  const [tab, setTab] = useState<"users" | "settings">("users");
  if (me?.role !== "admin") return <p className="text-zinc-400">Admins only.</p>;
  return (
    <div>
      <PageTitle>Admin</PageTitle>
      <div className="mb-4 flex rounded-lg bg-zinc-900 p-1" role="tablist">
        {(["users", "settings"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cx("rounded-md px-3 py-1 text-sm capitalize", tab === t ? "bg-zinc-700 text-white" : "text-zinc-400")}
          >
            {t === "users" ? "Users" : "Mail & SSO"}
          </button>
        ))}
      </div>
      {tab === "users" ? <Users /> : <SiteSettings />}
    </div>
  );
}
