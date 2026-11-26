import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { LabelT, Person } from "../types";
import { Avatar, Button, Card, Chip, Empty, ErrorText, Input, PageTitle, Select } from "../ui";

function PersonRow({ p, all }: { p: Person; all: Person[] }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [email, setEmail] = useState("");
  const [mergeInto, setMergeInto] = useState("");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["people"] });
    qc.invalidateQueries({ queryKey: ["photos"] });
    qc.invalidateQueries({ queryKey: ["concerts"] });
  };
  const save = useMutation({
    mutationFn: (body: { name?: string; linkedEmail?: string | null }) => api.patch(`/people/${p.id}`, body),
    onSuccess: () => {
      refresh();
      setEditing(false);
    },
  });
  const del = useMutation({ mutationFn: () => api.del(`/people/${p.id}`), onSuccess: refresh });
  const merge = useMutation({ mutationFn: (into: string) => api.post(`/people/${p.id}/merge`, { intoId: into }), onSuccess: refresh });

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={p.name} src={p.linkedUserImage} />
        <span className="font-medium">{p.name}</span>
        {p.linkedUserId && <Chip color="#22c55e">account: {p.linkedUserName}</Chip>}
        <span className="text-sm text-zinc-500">
          {p.concertCount} concerts · {p.photoCount} photos
        </span>
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" onClick={() => setEditing(!editing)}>
            {editing ? "Close" : "Edit"}
          </Button>
        </span>
      </div>
      {editing && (
        <div className="grid gap-2 rounded-lg bg-zinc-900 p-3 md:grid-cols-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({ name });
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            <Button>Rename</Button>
          </form>
          {p.linkedUserId ? (
            <Button variant="ghost" onClick={() => save.mutate({ linkedEmail: null })}>
              Unlink account
            </Button>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate({ linkedEmail: email });
              }}
            >
              <Input type="email" placeholder="Their account email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Link to account email" />
              <Button>Link</Button>
            </form>
          )}
          <div className="flex gap-2">
            <Select value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} aria-label="Merge into">
              <option value="">Merge into…</option>
              {all
                .filter((o) => o.id !== p.id)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
            </Select>
            <Button disabled={!mergeInto} onClick={() => merge.mutate(mergeInto)}>
              Merge
            </Button>
          </div>
          <Button variant="danger" className="md:col-span-3 md:justify-self-start" onClick={() => confirm(`Delete ${p.name}? Their tags are removed.`) && del.mutate()}>
            Delete
          </Button>
          <ErrorText error={save.error ?? merge.error ?? del.error} />
        </div>
      )}
    </li>
  );
}

function Labels() {
  const qc = useQueryClient();
  const { data: labels = [] } = useQuery({ queryKey: ["labels"], queryFn: () => api.get<LabelT[]>("/labels") });
  const [name, setName] = useState("");
  const [color, setColor] = useState("#f97316");
  const refresh = () => qc.invalidateQueries({ queryKey: ["labels"] });
  const create = useMutation({ mutationFn: () => api.post("/labels", { name, color }), onSuccess: () => (setName(""), refresh()) });
  const update = useMutation({ mutationFn: (v: { id: string; name?: string; color?: string }) => api.patch(`/labels/${v.id}`, v), onSuccess: refresh });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/labels/${id}`), onSuccess: refresh });
  const merge = useMutation({ mutationFn: (v: { id: string; into: string }) => api.post(`/labels/${v.id}/merge`, { intoId: v.into }), onSuccess: refresh });
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Labels</h2>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New label" required aria-label="New label" />
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 rounded bg-transparent" aria-label="Color" />
        <Button>Add</Button>
      </form>
      {!labels.length && <p className="text-sm text-zinc-500">No labels yet – add them while tagging photos.</p>}
      <ul className="divide-y divide-zinc-800">
        {labels.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <input type="color" value={l.color} onChange={(e) => update.mutate({ id: l.id, color: e.target.value })} className="h-6 w-8 rounded bg-transparent" aria-label={`${l.name} color`} />
            <span className="flex-1">{l.name}</span>
            <span className="text-zinc-500">{l.photoCount} photos</span>
            <Select
              className="w-auto"
              value=""
              onChange={(e) => e.target.value && merge.mutate({ id: l.id, into: e.target.value })}
              aria-label={`Merge ${l.name} into`}
            >
              <option value="">Merge into…</option>
              {labels
                .filter((o) => o.id !== l.id)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
            </Select>
            <Button variant="ghost" onClick={() => del.mutate(l.id)}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <ErrorText error={create.error ?? update.error ?? merge.error ?? del.error} />
    </Card>
  );
}

export function PeoplePage() {
  const qc = useQueryClient();
  const { data: people = [] } = useQuery({ queryKey: ["people"], queryFn: () => api.get<Person[]>("/people") });
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.post("/people", { name }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["people"] });
    },
  });
  return (
    <div className="space-y-4">
      <PageTitle>People & labels</PageTitle>
      <Card className="space-y-3">
        <h2 className="font-semibold">People</h2>
        <p className="text-sm text-zinc-400">
          Your private list of who you go with. Link someone to their ATC Gang account so photos you tag them in show up on their “Photos of
          me” (for concerts shared with them).
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required aria-label="New person" />
          <Button>Add</Button>
        </form>
        {people.length ? (
          <ul className="divide-y divide-zinc-800">
            {people.map((p) => (
              <PersonRow key={p.id} p={p} all={people} />
            ))}
          </ul>
        ) : (
          <Empty>No people yet.</Empty>
        )}
      </Card>
      <Labels />
    </div>
  );
}
