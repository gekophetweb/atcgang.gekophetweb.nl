import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "../lib/api";
import { STATUS_LABELS, type Concert, type Status } from "../types";
import { Button, ErrorText, Input, Label, Select, Textarea } from "../ui";

/** `datetime-local` value in the browser's timezone. */
export function toLocalInput(iso: string | Date | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[min(100vw-2rem,36rem)] rounded-xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 backdrop:bg-black/70"
    >
      <div className="max-h-[85vh] overflow-y-auto p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-zinc-400 hover:bg-zinc-800">
            ✕
          </button>
        </div>
        {open && children}
      </div>
    </dialog>
  );
}

interface Props {
  concert?: Concert;
  defaultStart?: Date;
  onDone: (c: Concert) => void;
}

export function ConcertForm({ concert, defaultStart, onDone }: Props) {
  const qc = useQueryClient();
  const start = defaultStart ?? (() => {
    const d = new Date();
    d.setHours(20, 0, 0, 0);
    return d;
  })();
  const [f, setF] = useState({
    artist: concert?.artist ?? "",
    title: concert?.title ?? "",
    venue: concert?.venue ?? "",
    city: concert?.city ?? "",
    country: concert?.country ?? "",
    startsAt: toLocalInput(concert?.startsAt ?? start),
    endsAt: toLocalInput(concert?.endsAt),
    status: (concert?.status ?? (start < new Date() ? "attended" : "planned")) as Status,
    ticketInfo: concert?.ticketInfo ?? "",
    setlistUrl: concert?.setlistUrl ?? "",
    notes: concert?.notes ?? "",
    rating: concert?.rating ? String(concert.rating) : "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...f,
        title: f.title || null,
        startsAt: new Date(f.startsAt).toISOString(),
        endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null,
        ticketInfo: f.ticketInfo || null,
        setlistUrl: f.setlistUrl || null,
        rating: f.rating ? Number(f.rating) : null,
      };
      return concert ? api.patch<Concert>(`/concerts/${concert.id}`, body) : api.post<Concert>("/concerts", body);
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["concerts"] });
      qc.invalidateQueries({ queryKey: ["concert", c.id] });
      onDone(c);
    },
  });

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="sm:col-span-2">
        <Label text="Artist">
          <Input required value={f.artist} onChange={set("artist")} autoFocus />
        </Label>
      </div>
      <div className="sm:col-span-2">
        <Label text="Tour / event name (optional)">
          <Input value={f.title} onChange={set("title")} />
        </Label>
      </div>
      <Label text="Venue">
        <Input value={f.venue} onChange={set("venue")} />
      </Label>
      <Label text="City">
        <Input value={f.city} onChange={set("city")} />
      </Label>
      <Label text="Starts">
        <Input type="datetime-local" required value={f.startsAt} onChange={set("startsAt")} />
      </Label>
      <Label text="Ends (optional)">
        <Input type="datetime-local" value={f.endsAt} onChange={set("endsAt")} />
      </Label>
      <Label text="Country">
        <Input value={f.country} onChange={set("country")} />
      </Label>
      <Label text="Status">
        <Select value={f.status} onChange={set("status")}>
          {Object.entries(STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Label>
      <Label text="Tickets">
        <Input value={f.ticketInfo} onChange={set("ticketInfo")} placeholder="e.g. Row 12, seat 4" />
      </Label>
      <Label text="Rating">
        <Select value={f.rating} onChange={set("rating")}>
          <option value="">–</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {"★".repeat(n)}
            </option>
          ))}
        </Select>
      </Label>
      <div className="sm:col-span-2">
        <Label text="Setlist link">
          <Input type="url" value={f.setlistUrl} onChange={set("setlistUrl")} placeholder="https://www.setlist.fm/…" />
        </Label>
      </div>
      <div className="sm:col-span-2">
        <Label text="Notes">
          <Textarea rows={3} value={f.notes} onChange={set("notes")} />
        </Label>
      </div>
      <div className="flex items-center justify-end gap-2 sm:col-span-2">
        <ErrorText error={save.error} />
        <Button variant="primary" disabled={save.isPending}>
          {concert ? "Save" : "Add concert"}
        </Button>
      </div>
    </form>
  );
}

export function NewConcertButton({ defaultStart }: { defaultStart?: Date }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        + Add concert
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Add concert">
        <ConcertForm
          defaultStart={defaultStart}
          onDone={(c) => {
            setOpen(false);
            navigate({ to: "/concerts/$id", params: { id: c.id } });
          }}
        />
      </Modal>
    </>
  );
}
