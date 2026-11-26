export interface IcsEvent {
  uid: string;
  start: Date;
  end?: Date | null;
  summary: string;
  location?: string;
  description?: string;
  url?: string;
  cancelled?: boolean;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Folds lines longer than 75 octets as RFC 5545 requires. */
function fold(line: string) {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

export function toIcs(e: IcsEvent, now = new Date()): string {
  const end = e.end ?? new Date(e.start.getTime() + 3 * 3600 * 1000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ATC Gang//Concerts//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(e.start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(e.summary)}`,
    ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
    ...(e.url ? [`URL:${e.url}`] : []),
    ...(e.cancelled ? ["STATUS:CANCELLED"] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
