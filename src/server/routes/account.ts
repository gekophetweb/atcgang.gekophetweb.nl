import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { currentUser, requireAdmin, type Env } from "../context.js";
import { adminOverview, exportData, lockAccount, mergeConcert, setUserDisabled, setUserRole } from "../domain/account.js";
import { deleteCookie } from "hono/cookie";

export function accountRoutes(deps: AppDeps) {
  const { db, storage, jobs, config } = deps;
  const r = new Hono<Env>();

  r.post("/concerts/:id/merge-into/:target", async (c) =>
    c.json(await mergeConcert(db, storage, currentUser(c).id, c.req.param("id"), c.req.param("target"))),
  );

  r.get("/export", async (c) => {
    const me = currentUser(c);
    const zip = await exportData(db, storage, me.id);
    c.header("content-type", "application/zip");
    c.header("content-disposition", `attachment; filename="atcgang-export-${new Date().toISOString().slice(0, 10)}.zip"`);
    c.header("cache-control", "no-store");
    return stream(c, async (s) => {
      for await (const chunk of zip) await s.write(chunk as Uint8Array);
    });
  });

  r.delete("/me", async (c) => {
    z.object({ confirm: z.literal("DELETE") }).parse(await c.req.json());
    const me = currentUser(c);
    await lockAccount(db, me.id);
    await jobs.send("account-deletion", { userId: me.id });
    deleteCookie(c, "better-auth.session_token", { path: "/" });
    deleteCookie(c, "__Secure-better-auth.session_token", { path: "/", secure: true });
    return c.body(null, 202);
  });

  r.get("/admin/overview", requireAdmin, async (c) => c.json(await adminOverview(db, storage, config.DISK_ALERT_PERCENT)));
  r.patch("/admin/users/:id", requireAdmin, async (c) => {
    const body = z.object({ disabled: z.boolean().optional(), role: z.enum(["user", "admin"]).optional() }).parse(await c.req.json());
    if (body.disabled !== undefined) await setUserDisabled(db, currentUser(c).id, c.req.param("id"), body.disabled);
    if (body.role) await setUserRole(db, currentUser(c).id, c.req.param("id"), body.role);
    return c.body(null, 204);
  });

  // Site settings: mail provider and SSO credentials (secrets are write-only).
  r.get("/admin/settings", requireAdmin, (c) => c.json(deps.settings.publicView()));
  r.put("/admin/settings/mail", requireAdmin, async (c) => {
    await deps.settings.saveMail(await c.req.json());
    return c.json(deps.settings.publicView());
  });
  r.put("/admin/settings/sso", requireAdmin, async (c) => {
    await deps.settings.saveSso(await c.req.json());
    return c.json({ ...deps.settings.publicView(), providers: deps.providers() });
  });
  r.post("/admin/settings/mail/test", requireAdmin, async (c) => {
    const me = currentUser(c);
    try {
      await deps.mailer.send({
        to: me.email,
        subject: "ATC Gang test email",
        text: `This is a test email sent with the "${deps.settings.mail.provider}" mail settings.`,
      });
      return c.json({ ok: true, to: me.email });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  return r;
}
