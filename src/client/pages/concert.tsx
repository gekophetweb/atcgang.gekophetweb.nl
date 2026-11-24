import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { api } from "../lib/api";
import { useMe } from "../layout";
import { STATUS_LABELS, type ConcertDetail, type Person } from "../types";
import { ConcertForm, Modal } from "../components/concert-form";
import { Picker } from "../components/picker";
import { ConcertPhotos } from "../components/photo-grid";
import { Avatar, Button, Card, ErrorText, Input, Select, Spinner } from "../ui";

function WhoWent({ c }: { c: ConcertDetail }) {
  const qc = useQueryClient();
  const { data: people = [] } = useQuery({ queryKey: ["people"], queryFn: () => api.get<Person[]>("/people") });
  const save = useMutation({
    mutationFn: (ids: string[]) => api.put(`/concerts/${c.id}/people`, { personIds: ids }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["concert", c.id] });
      qc.invalidateQueries({ queryKey: ["people"] });
    },
  });
  const canEdit = c.myRole !== "viewer";
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Who went</h2>
      <div className="flex flex-wrap gap-3">
        {c.members.map((m) => (
          <span key={m.id} className="flex items-center gap-2 text-sm">
            <Avatar name={m.name} src={m.image} /> {m.name}
            <span className="text-xs text-zinc-500">{m.role}</span>
          </span>
        ))}
      </div>
      {canEdit ? (
        <Picker
          label="Add people"
          placeholder="Add a friend…"
          options={people}
          selected={c.people}
          onAdd={async (p) => {
            const id = p.id ?? (await api.post<Person>("/people", { name: p.name })).id;
            save.mutate([...c.people.map((x) => x.id), id]);
          }}
          onRemove={(p) => save.mutate(c.people.filter((x) => x.id !== p.id).map((x) => x.id))}
        />
      ) : (
        <p className="text-sm text-zinc-400">{c.people.map((p) => p.name).join(", ")}</p>
      )}
      <p className="text-xs text-zinc-500">Your people list is private; other members don't see it.</p>
    </Card>
  );
}

function Sharing({ c }: { c: ConcertDetail }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [link, setLink] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["concert", c.id] });
  const invite = useMutation({
    mutationFn: (body: { email?: string; role: string }) => api.post<{ url: string }>(`/concerts/${c.id}/invites`, body),
    onSuccess: (r, body) => {
      if (!body.email) setLink(r.url);
      setEmail("");
      refresh();
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/concerts/${c.id}/invites/${id}`), onSuccess: refresh });
  const setMemberRole = useMutation({
    mutationFn: (v: { id: string; role: string }) => api.patch(`/concerts/${c.id}/members/${v.id}`, { role: v.role }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/concerts/${c.id}/members/${id}`),
    onSuccess: (_r, id) => {
      if (id === me?.id) {
        qc.invalidateQueries({ queryKey: ["concerts"] });
        navigate({ to: "/" });
      } else refresh();
    },
  });

  if (c.myRole !== "owner") {
    return (
      <Card className="flex items-center justify-between">
        <span className="text-sm text-zinc-400">Shared with you as {c.myRole}.</span>
        <Button variant="ghost" onClick={() => me && confirm("Leave this concert?") && remove.mutate(me.id)}>
          Leave
        </Button>
      </Card>
    );
  }
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Share</h2>
      <p className="text-sm text-zinc-400">Concerts are private. Invite friends who were there so you can all add photos.</p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate({ email, role });
        }}
      >
        <Input className="min-w-48 flex-1" type="email" required placeholder="friend@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Select className="w-auto" value={role} onChange={(e) => setRole(e.target.value as "editor")}>
          <option value="editor">Can add photos & edit</option>
          <option value="viewer">Can view</option>
        </Select>
        <Button variant="primary" disabled={invite.isPending}>
          Send invite
        </Button>
        <Button type="button" onClick={() => invite.mutate({ role })}>
          Create share link
        </Button>
      </form>
      {link && (
        <div className="flex gap-2">
          <Input readOnly value={link} onFocus={(e) => e.target.select()} />
          <Button onClick={() => navigator.clipboard.writeText(link)}>Copy</Button>
        </div>
      )}
      <ErrorText error={invite.error} />
      {c.members.length > 1 && (
        <ul className="divide-y divide-zinc-800 text-sm">
          {c.members
            .filter((m) => m.role !== "owner")
            .map((m) => (
              <li key={m.id} className="flex items-center gap-2 py-2">
                <Avatar name={m.name} src={m.image} /> <span className="flex-1">{m.name}</span>
                <Select className="w-auto" value={m.role} onChange={(e) => setMemberRole.mutate({ id: m.id, role: e.target.value })}>
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </Select>
                <Button variant="ghost" onClick={() => remove.mutate(m.id)}>
                  Remove
                </Button>
              </li>
            ))}
        </ul>
      )}
      {!!c.invites.length && (
        <ul className="text-sm text-zinc-400">
          {c.invites.map((i) => (
            <li key={i.id} className="flex items-center justify-between py-1">
              <span>
                {i.email ?? "Share link"} · {i.role} · until {new Date(i.expiresAt).toLocaleDateString()}
              </span>
              <Button variant="ghost" onClick={() => revoke.mutate(i.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ConcertPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const { data: c, isLoading, error } = useQuery({ queryKey: ["concert", id], queryFn: () => api.get<ConcertDetail>(`/concerts/${id}`) });
  const del = useMutation({
    mutationFn: () => api.del(`/concerts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["concerts"] });
      navigate({ to: "/" });
    },
  });
  if (isLoading) return <Spinner />;
  if (error || !c) return <ErrorText error={error ?? "Not found"} />;
  const d = new Date(c.startsAt);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-accent">
            {d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} ·{" "}
            {d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </p>
          <h1 className="text-3xl font-bold">{c.artist}</h1>
          {c.title && <p className="text-lg text-zinc-300">{c.title}</p>}
          <p className="text-zinc-400">{[c.venue, c.city, c.country].filter(Boolean).join(", ")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a className="rounded-lg bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700" href={`/api/concerts/${c.id}/ics`} download>
            Add to calendar
          </a>
          {c.myRole !== "viewer" && <Button onClick={() => setEditing(true)}>Edit</Button>}
          {c.myRole === "owner" && (
            <Button variant="danger" onClick={() => confirm(`Delete ${c.artist} and all its photos?`) && del.mutate()}>
              Delete
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="space-y-2 text-sm md:col-span-2">
          <div className="flex flex-wrap gap-4">
            <span>
              <span className="text-zinc-500">Status</span> {STATUS_LABELS[c.status]}
            </span>
            {c.rating && (
              <span aria-label={`${c.rating} of 5 stars`}>
                <span className="text-zinc-500">Rating</span> <span className="text-accent">{"★".repeat(c.rating)}</span>
                <span className="text-zinc-700">{"★".repeat(5 - c.rating)}</span>
              </span>
            )}
            {c.ticketInfo && (
              <span>
                <span className="text-zinc-500">Tickets</span> {c.ticketInfo}
              </span>
            )}
            {c.setlistUrl && (
              <a className="text-accent underline" href={c.setlistUrl} target="_blank" rel="noreferrer noopener">
                Setlist ↗
              </a>
            )}
          </div>
          {c.notes ? <p className="whitespace-pre-wrap text-zinc-300">{c.notes}</p> : <p className="text-zinc-500">No notes yet.</p>}
        </Card>
        <WhoWent c={c} />
      </div>
      <Sharing c={c} />
      <ConcertPhotos concertId={c.id} canUpload={c.myRole !== "viewer"} />

      <Modal open={editing} onClose={() => setEditing(false)} title="Edit concert">
        <ConcertForm concert={c} onDone={() => setEditing(false)} />
      </Modal>
    </div>
  );
}
