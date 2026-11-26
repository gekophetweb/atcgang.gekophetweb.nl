// Small built-in list of throwaway-mail domains; extend as abuse shows up.
const DISPOSABLE = new Set([
  "10minutemail.com", "20minutemail.com", "33mail.com", "anonaddy.me", "burnermail.io", "dispostable.com",
  "dropmail.me", "emailondeck.com", "fakeinbox.com", "getairmail.com", "getnada.com", "guerrillamail.com",
  "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com", "harakirimail.com", "inboxkitten.com",
  "mailcatch.com", "maildrop.cc", "mailinator.com", "mailinator.net", "mailnesia.com", "mailpoof.com",
  "mintemail.com", "moakt.com", "mohmal.com", "mytemp.email", "nada.email", "sharklasers.com", "spam4.me",
  "spamgourmet.com", "temp-mail.io", "temp-mail.org", "tempail.com", "tempmail.com", "tempmail.dev",
  "tempmailo.com", "tempr.email", "throwawaymail.com", "trashmail.com", "trashmail.de", "yopmail.com",
  "yopmail.fr", "yopmail.net",
]);

export function isDisposableEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase().trim();
  return !!domain && DISPOSABLE.has(domain);
}
