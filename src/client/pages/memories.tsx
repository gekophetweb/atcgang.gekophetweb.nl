import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api, qs } from "../lib/api";
import type { Concert } from "../types";
import { ConcertRow } from "./concerts";
import { Card, Empty, PageTitle, Spinner } from "../ui";

interface Stats {
  totals: { concerts: number; artists: number; venues: number; photos: number };
  perYear: { year: number; count: number }[];
  topArtists: { name: string; count: number }[];
  topVenues: { name: string; city: string; count: number }[];
  topPeople: { id: string; name: string; count: number }[];
  onThisDay: { id: string; artist: string; venue: string; city: string; startsAt: string; photoCount: number }[];
}

function Top({ title, rows }: { title: string; rows: { key: string; label: string; count: number }[] }) {
  return (
    <Card>
      <h2 className="mb-2 font-semibold">{title}</h2>
      {rows.length ? (
        <ol className="space-y-1 text-sm">
          {rows.map((r, i) => (
            <li key={r.key} className="flex gap-2">
              <span className="w-5 text-right text-zinc-500">{i + 1}.</span>
              <span className="flex-1 truncate">{r.label}</span>
              <span className="tabular-nums text-zinc-400">{r.count}×</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-zinc-500">Nothing yet.</p>
      )}
    </Card>
  );
}

export function MemoriesPage() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { data: st, isLoading } = useQuery({ queryKey: ["stats", tz], queryFn: () => api.get<Stats>(`/stats${qs({ tz })}`) });
  const { data: past } = useQuery({ queryKey: ["concerts", { when: "past" }], queryFn: () => api.get<Concert[]>("/concerts?when=past") });
  const byYear = useMemo(() => {
    const m = new Map<number, Concert[]>();
    for (const c of past ?? []) {
      if (c.status === "cancelled" || c.status === "skipped") continue;
      const y = new Date(c.startsAt).getFullYear();
      m.set(y, [...(m.get(y) ?? []), c]);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [past]);

  if (isLoading || !st) return <Spinner />;
  const max = Math.max(1, ...st.perYear.map((y) => y.count));
  return (
    <div className="space-y-6">
      <PageTitle>Memories</PageTitle>

      {st.onThisDay.map((c) => {
        const years = new Date().getFullYear() - new Date(c.startsAt).getFullYear();
        return (
          <Link key={c.id} to="/concerts/$id" params={{ id: c.id }} className="block rounded-xl bg-gradient-to-r from-accent/30 to-transparent p-4 ring-1 ring-accent/40">
            <p className="text-xs uppercase tracking-wide text-accent">On this day · {years} {years === 1 ? "year" : "years"} ago</p>
            <p className="text-xl font-bold">{c.artist}</p>
            <p className="text-sm text-zinc-300">
              {[c.venue, c.city].filter(Boolean).join(", ")}
              {c.photoCount > 0 && ` · ${c.photoCount} photos`}
            </p>
          </Link>
        );
      })}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(
          [
            ["Concerts", st.totals.concerts],
            ["Artists", st.totals.artists],
            ["Venues", st.totals.venues],
            ["Photos", st.totals.photos],
          ] as const
        ).map(([l, n]) => (
          <Card key={l}>
            <p className="text-3xl font-bold tabular-nums">{n}</p>
            <p className="text-sm text-zinc-400">{l}</p>
          </Card>
        ))}
      </div>

      {st.perYear.length > 0 && (
        <Card>
          <h2 className="mb-3 font-semibold">Concerts per year</h2>
          <div className="flex h-40 items-end gap-2 overflow-x-auto" role="img" aria-label={st.perYear.map((y) => `${y.year}: ${y.count}`).join(", ")}>
            {st.perYear.map((y) => (
              <div key={y.year} className="flex min-w-8 flex-1 flex-col items-center gap-1">
                <span className="text-xs tabular-nums text-zinc-400">{y.count}</span>
                <div className="w-full rounded-t bg-accent" style={{ height: `${(y.count / max) * 100}%`, minHeight: 4 }} />
                <span className="text-xs text-zinc-500">{y.year}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <Top title="Most seen artists" rows={st.topArtists.map((a) => ({ key: a.name, label: a.name, count: a.count }))} />
        <Top title="Venues" rows={st.topVenues.map((v) => ({ key: v.name, label: [v.name, v.city].filter(Boolean).join(", "), count: v.count }))} />
        <Top title="Went with most" rows={st.topPeople.map((p) => ({ key: p.id, label: p.name, count: p.count }))} />
      </div>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Timeline</h2>
        {byYear.length ? (
          byYear.map(([year, list]) => (
            <div key={year}>
              <h3 className="sticky top-14 z-10 bg-zinc-950/90 px-3 py-1 text-2xl font-bold text-zinc-500 backdrop-blur">{year}</h3>
              <div className="divide-y divide-zinc-900">
                {list.map((c) => (
                  <ConcertRow key={c.id} c={c} />
                ))}
              </div>
            </div>
          ))
        ) : (
          <Empty>Concerts you went to will show up here.</Empty>
        )}
      </section>
    </div>
  );
}
