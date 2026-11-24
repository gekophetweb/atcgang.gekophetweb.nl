import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { authClient, PROVIDER_LABELS } from "../lib/auth";
import { api } from "../lib/api";
import { Button, Card, ErrorText, Input, Label } from "../ui";

interface PublicConfig {
  providers: string[];
  turnstileSiteKey: string | null;
}

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; "expired-callback"?: () => void }): string;
      reset(id?: string): void;
    };
  }
}

function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const render = () => {
      if (ref.current && window.turnstile && !ref.current.dataset.rendered) {
        ref.current.dataset.rendered = "1";
        window.turnstile.render(ref.current, { sitekey: siteKey, callback: onToken, "expired-callback": () => onToken(null) });
      }
    };
    if (window.turnstile) return render();
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = render;
    document.head.appendChild(s);
  }, [siteKey, onToken]);
  return <div ref={ref} />;
}

export function LoginPage() {
  const search = useSearch({ strict: false }) as { redirect?: string };
  const redirect = search.redirect && search.redirect.startsWith("/") ? search.redirect : "/";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: () => api.get<PublicConfig>("/config") });
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.emailOtp.sendVerificationOtp(
      { email, type: "sign-in" },
      { headers: captcha ? { "x-captcha-response": captcha } : undefined },
    );
    setBusy(false);
    if (error) return setError(error.message ?? "Could not send the code");
    setStep("code");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.emailOtp({ email, otp: code.trim() });
    setBusy(false);
    if (error) return setError(error.message ?? "That code didn't work");
    await qc.invalidateQueries({ queryKey: ["me"] });
    navigate({ to: redirect });
  }

  async function sso(provider: string) {
    await authClient.signIn.social({ provider: provider as "google", callbackURL: redirect, errorCallbackURL: "/login" });
  }

  return (
    <main className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-sm space-y-5 p-6">
        <div>
          <h1 className="text-2xl font-bold">ATC Gang</h1>
          <p className="text-sm text-zinc-400">Keep track of the shows you go to.</p>
        </div>

        {step === "email" ? (
          <form onSubmit={sendCode} className="space-y-3">
            <Label text="Email">
              <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </Label>
            {config?.turnstileSiteKey && <Turnstile siteKey={config.turnstileSiteKey} onToken={setCaptcha} />}
            <Button variant="primary" className="w-full" disabled={busy || (!!config?.turnstileSiteKey && !captcha)}>
              Send login code
            </Button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-3">
            <p className="text-sm text-zinc-300">
              We sent a 6-digit code to <b>{email}</b>. It's valid for 10 minutes.
            </p>
            <Label text="Code">
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="text-center text-2xl tracking-[0.5em]"
              />
            </Label>
            <Button variant="primary" className="w-full" disabled={busy || code.length !== 6}>
              Sign in
            </Button>
            <button type="button" className="text-sm text-zinc-400 underline" onClick={() => setStep("email")}>
              Use another email
            </button>
          </form>
        )}
        <ErrorText error={error} />

        {!!config?.providers.length && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="h-px flex-1 bg-zinc-800" /> or <span className="h-px flex-1 bg-zinc-800" />
            </div>
            {config.providers.map((p) => (
              <Button key={p} className="w-full" onClick={() => sso(p)}>
                Continue with {PROVIDER_LABELS[p] ?? p}
              </Button>
            ))}
          </div>
        )}
        <p className="text-xs text-zinc-500">
          By signing in you agree to the <a className="underline" href="/terms">terms</a> and{" "}
          <a className="underline" href="/privacy">privacy policy</a>. We only use an essential session cookie.
        </p>
      </Card>
    </main>
  );
}
