import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMe } from "../layout";
import { Button, Card, ErrorText, Spinner } from "../ui";

interface PublicClient {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
}

const SCOPE_TEXT: Record<string, string> = {
  openid: "Know who you are",
  profile: "See your name and picture",
  email: "See your email address",
  offline_access: "Stay connected until you revoke access",
};

/** OAuth consent for MCP clients (Claude etc.) asking to use your ATC Gang data. */
export function ConsentPage() {
  const { data: me } = useMe();
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id") ?? "";
  const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: client, isLoading } = useQuery({
    queryKey: ["oauth-client", clientId],
    queryFn: async () => {
      const r = await fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`);
      return r.ok ? ((await r.json()) as PublicClient) : null;
    },
    enabled: !!clientId,
  });

  async function decide(accept: boolean) {
    setBusy(true);
    setError(null);
    const r = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept, oauth_query: window.location.search.slice(1) }),
    });
    const body = await r.json().catch(() => ({}));
    setBusy(false);
    if (body.url) window.location.href = body.url;
    else setError(body.error_description ?? body.message ?? "Something went wrong");
  }

  if (isLoading) return <Spinner />;
  const name = client?.client_name ?? "An app";
  return (
    <Card className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-bold">{name} wants to connect</h1>
      <p className="text-sm text-zinc-300">
        It will be able to read and change your concerts, people, labels and photo tags as <b>{me?.email}</b>, with the same access you have
        here. It sees photos only through links that expire after an hour.
      </p>
      {client?.client_uri && <p className="text-xs text-zinc-500">{client.client_uri}</p>}
      {scopes.length > 0 && (
        <ul className="list-inside list-disc text-sm text-zinc-400">
          {scopes.map((s) => (
            <li key={s}>{SCOPE_TEXT[s] ?? s}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-zinc-500">You can revoke access any time in Settings → AI connections.</p>
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy} onClick={() => decide(true)}>
          Allow
        </Button>
        <Button disabled={busy} onClick={() => decide(false)}>
          Deny
        </Button>
      </div>
      <ErrorText error={error} />
    </Card>
  );
}
