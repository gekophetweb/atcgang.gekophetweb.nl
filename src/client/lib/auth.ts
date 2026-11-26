import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  plugins: [emailOTPClient(), oauthProviderClient()],
});

export const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
  apple: "Apple",
  github: "GitHub",
};
