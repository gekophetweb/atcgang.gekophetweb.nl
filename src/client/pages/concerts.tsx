import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api, qs } from "../lib/api";
import { STATUS_LABELS, type Concert, type Person } from "../types";
import { NewConcertButton } from "../components/concert-form";
import { useRedirectToPreferredView, ViewToggle } from "../components/view-toggle";
import { Avatar, cx, Empty, Input, PageTitle, Select, Spinner } from "../ui";

const monthKey = (d: Date) => d.toLocaleDateString(undefined, { month: "long", year: "numeric" });

function useStored<T extends string>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (next: T) => {
      setV(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        /* storage unavailable */
      }
    },
  ] as const;
}

export function ConcertRow({ c }: { c: Concert }) {
  const d = new Date(c.startsAt);
  return (
    <Link
      to="/concerts/$id"
      params={{ id: c.id }}
      className="flex items-center gap-4 rounded-lg px-3 py-3 hover:bg-zinc-900 focus-visible:bg-zinc-900"
    >
      <div className="w-12 shrink-0 text-center">
        <div className="text-xs uppercase text-accent">{d.toLocaleDateString(undefined, { weekday: "short" })}</div>
        <div className="text-xl font-bold leading-tight">{d.getDate()}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">
          {c.artist}
          {c.title && <span className="font-normal text-zinc-400"> · {c.title}</span>}
        </div>
        <div className="truncate text-sm text-zinc-400">
          {[c.venue, c.city].filter(Boolean).join(", ")} ·{" "}
          {d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          {c.status !== "planned" && <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-xs">{STATUS_LABELS[c.status]}</span>}
        </div>
      </div>
      <div className="hidden -space-x-2 sm:flex">
        {c.members.slice(0, 4).map((m) => (
          <Avatar key={m.id} name={m.name} src={m.image} />
        ))}
        {c.people.slice(0, 3).map((p) => (
          <Avatar key={p.id} name={p.name} />
        ))}
      </div>
      {c.photoCount > 0 && <span className="shrink-0 text-sm text-zinc-400">📷 {c.photoCount}</span>}
    </Link>
  );
}

export function ConcertsPage() {
  useRedirectToPreferredView();
  const [tab, setTab] = useStored<"upcoming" | "past">("concerts.tab", "upcoming");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [year, setYear] = useState("");
  const [person, setPerson] = useState("");
  const { data: people } = useQuery({ queryKey: ["people"], queryFn: () => api.get<Person[]>("/people") });
  const { data, isLoading } = useQuery({
    queryKey: ["concerts", { tab, q, status, year, person }],
    queryFn: () => api.get<Concert[]>(`/concerts${qs({ when: tab, q, status, year, person })}`),
  });

  const groups = useMemo(() => {
    const m = new Map<string, Concert[]>();
    for (const c of data ?? []) {
      const k = monthKey(new Date(c.startsAt));
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return [...m.entries()];
  }, [data]);

  const thisYear = new Date().getFullYear();
  return (
    <div>
      <PageTitle
        actions={
          <>
            <ViewToggle current="list" />
            <NewConcertButton />
          </>
        }
      >
        Concerts
      </PageTitle>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-zinc-900 p-1" role="tablist">
          {(["upcoming", "past"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cx("rounded-md px-3 py-1 text-sm capitalize", tab === t ? "bg-zinc-700 text-white" : "text-zinc-400")}
            >
              {t}
            </button>
          ))}
        </div>
        <Input className="max-w-xs" type="search" placeholder="Search artist, venue, city" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <Select className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {Object.entries(STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        <Select className="w-auto" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year">
          <option value="">Any year</option>
          {Array.from({ length: 40 }, (_, i) => thisYear + 2 - i).map((y) => (
            <option key={y}>{y}</option>
          ))}
        </Select>
        {!!people?.length && (
          <Select className="w-auto" value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Person">
            <option value="">Anyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {isLoading ? (
        <Spinner />
      ) : !groups.length ? (
        <Empty>{tab === "upcoming" ? "No upcoming concerts. Add the next one!" : "Nothing here yet."}</Empty>
      ) : (
        <div className="space-y-6">
          {groups.map(([month, list]) => (
            <section key={month}>
              <h2 className="mb-1 px-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">{month}</h2>
              <div className="divide-y divide-zinc-900">
                {list.map((c) => (
                  <ConcertRow key={c.id} c={c} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
