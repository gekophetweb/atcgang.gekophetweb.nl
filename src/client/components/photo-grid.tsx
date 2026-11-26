import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, qs } from "../lib/api";
import type { LabelT, Person, Photo } from "../types";
import { Lightbox, useTagMutation } from "./lightbox";
import { Uploader } from "./uploader";
import { Picker } from "./picker";
import { Button, Card, cx, Empty, ErrorText, Spinner } from "../ui";

export function usePhotos(params: Record<string, string | undefined>) {
  return useQuery({
    queryKey: ["photos", params],
    queryFn: () => api.get<Photo[]>(`/photos${qs(params)}`),
    // Poll while thumbnails are still being made.
    refetchInterval: (q) => (q.state.data?.some((p) => !p.thumbsReady) ? 3000 : false),
  });
}

function BulkBar({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const { data: labels = [] } = useQuery({ queryKey: ["labels"], queryFn: () => api.get<LabelT[]>("/labels") });
  const { data: people = [] } = useQuery({ queryKey: ["people"], queryFn: () => api.get<Person[]>("/people") });
  const tag = useTagMutation();
  return (
    <Card className="sticky top-14 z-20 grid gap-3 md:grid-cols-[auto_1fr_1fr_auto] md:items-start">
      <p className="text-sm font-medium">{ids.length} selected</p>
      <Picker
        label="Add label to selected"
        placeholder="Add label to all…"
        options={labels}
        selected={[]}
        onAdd={(l) => tag.mutate({ photoIds: ids, addLabels: [l.id ? { id: l.id } : { name: l.name }] })}
        onRemove={() => {}}
      />
      <Picker
        label="Tag person on selected"
        placeholder="Tag person on all…"
        options={people}
        selected={[]}
        onAdd={(p) => tag.mutate({ photoIds: ids, addPeople: [p.id ? { id: p.id } : { name: p.name }] })}
        onRemove={() => {}}
      />
      <Button onClick={onDone}>Done</Button>
      {tag.isSuccess && <p className="text-xs text-green-400 md:col-span-4">Applied to {ids.length} photos.</p>}
      <ErrorText error={tag.error} />
    </Card>
  );
}

export function PhotoGrid({ photos, selectable = true }: { photos: Photo[]; selectable?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const editable = photos.filter((p) => p.canEdit);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  return (
    <div className="space-y-3">
      {selectable && editable.length > 1 && (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setSelecting(!selecting);
              setSelected(new Set());
            }}
          >
            {selecting ? "Cancel selection" : "Select photos"}
          </Button>
          {selecting && (
            <Button variant="ghost" onClick={() => setSelected(new Set(editable.map((p) => p.id)))}>
              Select all
            </Button>
          )}
        </div>
      )}
      {selecting && selected.size > 0 && (
        <BulkBar
          ids={[...selected]}
          onDone={() => {
            setSelecting(false);
            setSelected(new Set());
          }}
        />
      )}
      <ul className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
        {photos.map((p, i) => (
          <li key={p.id} className="relative aspect-square">
            <button
              className={cx(
                "block h-full w-full overflow-hidden rounded-md bg-zinc-800 focus-visible:outline-2 focus-visible:outline-accent",
                selected.has(p.id) && "ring-4 ring-accent",
              )}
              onClick={() => (selecting ? p.canEdit && toggle(p.id) : setOpen(i))}
              aria-label={p.caption ?? `Photo ${i + 1}`}
              aria-pressed={selecting ? selected.has(p.id) : undefined}
            >
              {p.thumbsReady ? (
                <img src={`/photos/${p.id}/thumb`} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
              ) : (
                <span className="grid h-full w-full animate-pulse place-items-center text-xs text-zinc-500">Processing…</span>
              )}
            </button>
            {(p.labels.length > 0 || p.people.length > 0) && !selecting && (
              <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px]">
                {p.people.length > 0 && `👤${p.people.length}`} {p.labels.length > 0 && `🏷${p.labels.length}`}
              </span>
            )}
          </li>
        ))}
      </ul>
      {open !== null && <Lightbox photos={photos} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function ConcertPhotos({ concertId, canUpload }: { concertId: string; canUpload: boolean }) {
  const { data, isLoading, error } = usePhotos({ concert: concertId });
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Photos {data?.length ? <span className="text-zinc-500">({data.length})</span> : null}</h2>
      {canUpload && <Uploader concertId={concertId} />}
      {isLoading ? <Spinner /> : error ? <ErrorText error={error} /> : data?.length ? <PhotoGrid photos={data} /> : !canUpload && <Empty>No photos yet.</Empty>}
    </section>
  );
}
