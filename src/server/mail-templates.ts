import type { Mail } from "./lib/mailer.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function layout(body: string) {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#f4f4f5;padding:24px">
<div style="max-width:480px;margin:auto;background:#fff;border-radius:12px;padding:24px;color:#18181b">${body}
<p style="color:#71717a;font-size:12px;margin-top:24px">ATC Gang · atcgang.gekophetweb.nl</p></div></body></html>`;
}

export function loginCodeMail(to: string, code: string): Mail {
  return {
    to,
    subject: `Your ATC Gang login code: ${code}`,
    text: `Your login code is ${code}\n\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.`,
    html: layout(
      `<p>Your login code:</p><p style="font-size:32px;font-weight:700;letter-spacing:6px">${esc(code)}</p>
<p>It expires in 10 minutes. If you didn't ask for it, ignore this email.</p>`,
    ),
  };
}

export function inviteMail(to: string, inviter: string, concert: string, url: string): Mail {
  return {
    to,
    subject: `${inviter} invited you to ${concert}`,
    text: `${inviter} invited you to ${concert} on ATC Gang.\n\nOpen the invite: ${url}\n\nThe link is valid for 14 days.`,
    html: layout(
      `<p><b>${esc(inviter)}</b> invited you to <b>${esc(concert)}</b>.</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#f97316;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open the invite</a></p>
<p style="color:#71717a">The link is valid for 14 days.</p>`,
    ),
  };
}

export function tagMail(to: string, tagger: string, count: number, concert: string, url: string, thumbs: string[]): Mail {
  const what = count === 1 ? "a photo" : `${count} photos`;
  return {
    to,
    subject: `${tagger} tagged you in ${what} from ${concert}`,
    text: `${tagger} tagged you in ${what} from ${concert}.\n\nSee them: ${url}\n\nTurn these emails off in Settings.`,
    html: layout(
      `<p><b>${esc(tagger)}</b> tagged you in ${what} from <b>${esc(concert)}</b>.</p>
<p>${thumbs.map((t) => `<img src="${esc(t)}" width="96" height="96" style="object-fit:cover;border-radius:6px;margin:2px">`).join("")}</p>
<p><a href="${esc(url)}">See the photos</a></p><p style="color:#71717a;font-size:12px">Turn these emails off in Settings.</p>`,
    ),
  };
}
