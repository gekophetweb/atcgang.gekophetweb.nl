import type { ReactNode } from "react";

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-10 text-zinc-300 [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-zinc-100">
      <a href="/" className="text-sm text-accent">
        ← ATC Gang
      </a>
      <h1 className="text-3xl font-bold text-zinc-100">{title}</h1>
      {children}
    </main>
  );
}

export function PrivacyPage() {
  return (
    <Page title="Privacy policy">
      <p>ATC Gang (atcgang.gekophetweb.nl) is a small, privately run site for keeping track of concerts and sharing photos with friends who were there.</p>
      <h2>What we store</h2>
      <ul className="list-inside list-disc space-y-1">
        <li>Your account: email address, name and profile picture (from your sign-in provider, if you use one).</li>
        <li>What you add: concerts, notes, ratings, people and labels, photos you upload and the tags on them.</li>
        <li>Technical data: your IP address and browser with each session, used for security and rate limiting.</li>
      </ul>
      <h2>Who can see it</h2>
      <p>
        Everything is private by default. A concert and its photos are visible only to the people you invite to it. Your list of people and
        labels is visible only to you, except that names you tag on shared photos are shown to that concert's members. Nothing is public or
        indexed by search engines.
      </p>
      <h2>Cookies</h2>
      <p>We use one essential cookie to keep you signed in. No tracking or advertising cookies.</p>
      <h2>Services we use</h2>
      <ul className="list-inside list-disc space-y-1">
        <li>Cloudflare, which carries all traffic to the site and protects it against abuse (Turnstile).</li>
        <li>An email provider to send login codes and notifications.</li>
        <li>The sign-in provider you choose (Google, Microsoft, Apple or GitHub), if any.</li>
        <li>Encrypted off-site backups of the database and photos.</li>
      </ul>
      <h2>AI connections</h2>
      <p>
        If you connect an AI client (such as Claude) through MCP, it can read and change your data with the same access you have, until you
        revoke it in Settings. It receives photos only as links that expire after an hour.
      </p>
      <h2>Your rights</h2>
      <p>
        You can download all your data (Settings → Export) and delete your account at any time (Settings → Delete my account). Deleting removes
        your account, your photos and concerts that only you were in; concerts shared with others pass to another member. Backups are kept for
        14 days, so deleted data is gone from backups within 14 days.
      </p>
      <p>Questions or requests: contact the site owner via the email address you received your login codes from.</p>
    </Page>
  );
}

export function TermsPage() {
  return (
    <Page title="Terms of use">
      <p>By creating an account you agree to these terms.</p>
      <h2>Your content</h2>
      <p>
        You keep the rights to the photos and text you add. You give ATC Gang permission to store them and show them to the people you share them
        with. Only upload photos you are allowed to share, and respect the privacy of the people in them – tagged people can remove their tag.
      </p>
      <h2>Fair use</h2>
      <ul className="list-inside list-disc space-y-1">
        <li>Each account has a storage limit for photos (2 GB by default).</li>
        <li>No illegal content, harassment, spam or attempts to break or overload the site.</li>
        <li>The administrator may disable accounts that break these rules.</li>
      </ul>
      <h2>No guarantees</h2>
      <p>
        ATC Gang runs on a home server and is offered as is, without guarantees of availability. We make nightly backups, but keep your own copy of
        photos that matter to you (Settings → Export).
      </p>
      <h2>Changes</h2>
      <p>These terms may change; the current version is always on this page.</p>
    </Page>
  );
}
