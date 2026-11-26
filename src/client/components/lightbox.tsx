import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../lib/api";
import { useMe } from "../layout";
import type { LabelT, Person, Photo } from "../types";
import { Picker } from "./picker";
import { Button, ErrorText } from "../ui";

export type TagChange = {
  photoIds: string[];
  addLabels?: ({ id: string } | { name: string })[];
  removeLabels?: string[];
  addPeople?: ({ id: string; x?: number; y?: number } | { name: string; x?: number; y?: number })[];
  removePeople?: string[];
};

export function useTagMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TagChange) => api.post("/photos/bulk-tag", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["photos"] });
      qc.invalidateQueries({ queryKey: ["labels"] });
      qc.invalidateQueries({ queryKey: ["people"] });
    },
  });
}

function TagPanel({ photo, pinMode, setPinMode }: { photo: Photo; pinMode: boolean; setPinMode: (v: boolean) => void }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { data: labels = [] } = useQuery({ queryKey: ["labels"], queryFn: () => api.get<LabelT[]>("/labels") });
  const { data: people = [] } = useQuery({ queryKey: ["people"], queryFn: () => api.get<Person[]>("/people") });
  const tag = useTagMutation();
  const untagMe = useMutation({
    mutationFn: () => api.del(`/photos/${photo.id}/people/me`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["photos"] }),
  });
  const caption = useMutation({
    mutationFn: (c: string) => api.patch(`/photos/${photo.id}`, { caption: c || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["photos"] }),
  });
  const taggedMe = photo.people.some((p) => p.linkedUserId === me?.id);

  return (
    <div className="space-y-4 text-sm">
      {photo.concert && (
        <Link to="/concerts/$id" params={{ id: photo.concertId }} className="block hover:underline">
          <div className="font-semibold">{photo.concert.artist}</div>
          <div className="text-zinc-400">
            {new Date(photo.concert.startsAt).toLocaleDateString()} · {photo.concert.venue}
          </div>
        </Link>
      )}
      {photo.takenAt && <p className="text-zinc-400">Taken {new Date(photo.takenAt).toLocaleString()}</p>}
      {photo.canEdit ? (
        <input
          key={photo.id}
          defaultValue={photo.caption ?? ""}
          placeholder="Add a caption…"
          onBlur={(e) => e.target.value !== (photo.caption ?? "") && caption.mutate(e.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
          aria-label="Caption"
        />
      ) : (
        photo.caption && <p>{photo.caption}</p>
      )}
      <div>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-400">Labels</h3>
        {photo.canEdit ? (
          <Picker
            label="Add label"
            placeholder="encore, crowd, merch…"
            options={labels}
            selected={photo.labels}
            onAdd={(l) => tag.mutate({ photoIds: [photo.id], addLabels: [l.id ? { id: l.id } : { name: l.name }] })}
            onRemove={(l) => tag.mutate({ photoIds: [photo.id], removeLabels: [l.id] })}
          />
        ) : (
          <p>{photo.labels.map((l) => l.name).join(", ") || "–"}</p>
        )}
      </div>
      <div>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-400">People</h3>
        {photo.canEdit ? (
          <>
            <Picker
              label="Tag person"
              placeholder="Who's in this photo?"
              options={people}
              selected={photo.people.filter((p) => p.mine)}
              onAdd={(p) => tag.mutate({ photoIds: [photo.id], addPeople: [p.id ? { id: p.id } : { name: p.name }] })}
              onRemove={(p) => tag.mutate({ photoIds: [photo.id], removePeople: [p.id] })}
            />
            {photo.people.some((p) => !p.mine) && (
              <p className="mt-1 text-zinc-400">Also tagged: {photo.people.filter((p) => !p.mine).map((p) => p.name).join(", ")}</p>
            )}
            <button className="mt-2 text-xs text-accent underline" onClick={() => setPinMode(!pinMode)}>
              {pinMode ? "Cancel pinning" : "Pin a person on the photo"}
            </button>
          </>
        ) : (
          <p>{photo.people.map((p) => p.name).join(", ") || "–"}</p>
        )}
      </div>
      {taggedMe && (
        <Button variant="ghost" onClick={() => untagMe.mutate()}>
          Remove my tag
        </Button>
      )}
      <ErrorText error={tag.error ?? untagMe.error ?? caption.error} />
    </div>
  );
}

function PinPrompt({ x, y, onPick, onCancel }: { x: number; y: number; onPick: (name: { id: string } | { name: string }) => void; onCancel: () => void }) {
  const { data: people = [] } = useQuery({ queryKey: ["people"], queryFn: () => api.get<Person[]>("/people") });
  const [q, setQ] = useState("");
  const matches = people.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 6);
  return (
    <div className="absolute z-10 w-48 rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-sm shadow-xl" style={{ left: `${x * 100}%`, top: `${y * 100}%` }} onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && q.trim()) onPick(matches[0] ? { id: matches[0].id } : { name: q.trim() });
        }}
        placeholder="Name"
        className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
        aria-label="Person name"
      />
      {matches.map((m) => (
        <button key={m.id} className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800" onClick={() => onPick({ id: m.id })}>
          {m.name}
        </button>
      ))}
    </div>
  );
}

export function Lightbox({ photos, index, onIndex, onClose }: { photos: Photo[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const photo = photos[index];
  const qc = useQueryClient();
  const ref = useRef<HTMLDialogElement>(null);
  const touch = useRef<number | null>(null);
  const [pinMode, setPinMode] = useState(false);
  const [pin, setPin] = useState<{ x: number; y: number } | null>(null);
  const tag = useTagMutation();
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/photos/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["photos"] });
      qc.invalidateQueries({ queryKey: ["usage"] });
      if (photos.length <= 1) onClose();
      else onIndex(Math.min(index, photos.length - 2));
    },
  });

  useEffect(() => {
    ref.current?.showModal();
  }, []);
  useEffect(() => {
    setPin(null);
    setPinMode(false);
  }, [index]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "ArrowRight") onIndex(Math.min(index + 1, photos.length - 1));
      if (e.key === "ArrowLeft") onIndex(Math.max(index - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, photos.length, onIndex]);

  if (!photo) return null;
  return (
    <dialog ref={ref} onClose={onClose} className="m-0 h-full max-h-none w-full max-w-none bg-black/95 p-0 text-zinc-100" aria-label="Photo viewer">
      <div className="flex h-full flex-col md:flex-row">
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center p-2"
          onTouchStart={(e) => (touch.current = e.touches[0]!.clientX)}
          onTouchEnd={(e) => {
            if (touch.current === null) return;
            const dx = e.changedTouches[0]!.clientX - touch.current;
            if (dx < -50) onIndex(Math.min(index + 1, photos.length - 1));
            if (dx > 50) onIndex(Math.max(index - 1, 0));
            touch.current = null;
          }}
        >
          <div className="relative inline-block max-h-full">
            <img
              src={photo.thumbsReady ? `/photos/${photo.id}/large` : `/photos/${photo.id}/original`}
              alt={photo.caption ?? `Photo from ${photo.concert?.artist ?? "concert"}`}
              className={`max-h-[calc(100vh-5rem)] max-w-full object-contain ${pinMode ? "cursor-crosshair" : ""}`}
              onClick={(e) => {
                if (!pinMode) return;
                const r = e.currentTarget.getBoundingClientRect();
                setPin({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
              }}
            />
            {photo.people
              .filter((p) => p.x !== null && p.y !== null)
              .map((p) => (
                <span
                  key={p.id}
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/70 px-2 py-0.5 text-xs ring-1 ring-accent"
                  style={{ left: `${p.x! * 100}%`, top: `${p.y! * 100}%` }}
                >
                  {p.name}
                </span>
              ))}
            {pin && (
              <PinPrompt
                x={pin.x}
                y={pin.y}
                onCancel={() => setPin(null)}
                onPick={(who) => {
                  tag.mutate({ photoIds: [photo.id], addPeople: [{ ...who, x: pin.x, y: pin.y }] });
                  setPin(null);
                  setPinMode(false);
                }}
              />
            )}
          </div>
          {index > 0 && (
            <button className="absolute left-2 top-1/2 rounded-full bg-black/60 p-3 text-xl" onClick={() => onIndex(index - 1)} aria-label="Previous photo">
              ‹
            </button>
          )}
          {index < photos.length - 1 && (
            <button className="absolute right-2 top-1/2 rounded-full bg-black/60 p-3 text-xl" onClick={() => onIndex(index + 1)} aria-label="Next photo">
              ›
            </button>
          )}
        </div>
        <aside className="max-h-[45vh] w-full shrink-0 overflow-y-auto border-t border-zinc-800 bg-zinc-950 p-4 md:max-h-none md:w-80 md:border-l md:border-t-0">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs text-zinc-500">
              {index + 1} / {photos.length}
            </span>
            <div className="flex gap-1">
              <a href={`/photos/${photo.id}/original`} className="rounded-lg px-2 py-1 text-sm hover:bg-zinc-800" download>
                Download
              </a>
              {photo.canDelete && (
                <button className="rounded-lg px-2 py-1 text-sm text-red-400 hover:bg-zinc-800" onClick={() => confirm("Delete this photo?") && del.mutate(photo.id)}>
                  Delete
                </button>
              )}
              <button className="rounded-lg px-2 py-1 hover:bg-zinc-800" onClick={() => ref.current?.close()} aria-label="Close viewer">
                ✕
              </button>
            </div>
          </div>
          <TagPanel photo={photo} pinMode={pinMode} setPinMode={setPinMode} />
        </aside>
      </div>
    </dialog>
  );
}
