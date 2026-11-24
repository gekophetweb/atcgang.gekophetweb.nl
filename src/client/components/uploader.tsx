import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { prepareFile, sendPhoto, UploadError } from "../lib/upload";
import { Button, cx } from "../ui";

interface Item {
  key: string;
  name: string;
  preview: string | null;
  progress: number;
  status: "waiting" | "preparing" | "uploading" | "done" | "error";
  error?: string;
  attempts: number;
  file: File;
}

const PARALLEL = 3;
const MAX_ATTEMPTS = 3;

export function Uploader({ concertId }: { concertId: string }) {
  const qc = useQueryClient();
  const [items, setItems] = useState<Item[]>([]);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const running = useRef(0);
  const queue = useRef<Item[]>([]);

  const patch = (key: string, p: Partial<Item>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));

  const pump = useCallback(() => {
    while (running.current < PARALLEL && queue.current.length) {
      const item = queue.current.shift()!;
      running.current++;
      void (async () => {
        try {
          patch(item.key, { status: "preparing", error: undefined });
          const { blob, takenAt, type } = await prepareFile(item.file);
          patch(item.key, { status: "uploading", preview: item.preview ?? URL.createObjectURL(blob) });
          for (let attempt = 1; ; attempt++) {
            try {
              await sendPhoto(concertId, blob, type, takenAt, (p) => patch(item.key, { progress: p }));
              break;
            } catch (e) {
              if (!(e instanceof UploadError) || !e.retryable || attempt >= MAX_ATTEMPTS) throw e;
              await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            }
          }
          patch(item.key, { status: "done", progress: 1 });
          qc.invalidateQueries({ queryKey: ["photos"] });
          qc.invalidateQueries({ queryKey: ["usage"] });
        } catch (e) {
          patch(item.key, { status: "error", error: e instanceof Error ? e.message : "Upload failed" });
        } finally {
          running.current--;
          pump();
        }
      })();
    }
  }, [concertId, qc]);

  function add(files: FileList | File[]) {
    const next: Item[] = [...files].map((file) => ({
      key: `${file.name}-${file.size}-${Math.random()}`,
      name: file.name,
      preview: /image\/(jpeg|png|webp)/.test(file.type) ? URL.createObjectURL(file) : null,
      progress: 0,
      status: "waiting",
      attempts: 0,
      file,
    }));
    setItems((list) => [...list.filter((i) => i.status !== "done"), ...next]);
    queue.current.push(...next);
    pump();
  }

  function retry(item: Item) {
    patch(item.key, { status: "waiting", progress: 0, error: undefined });
    queue.current.push(item);
    pump();
  }

  const active = items.filter((i) => i.status !== "done");
  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files.length) add(e.dataTransfer.files);
        }}
        className={cx(
          "flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center text-sm transition",
          drag ? "border-accent bg-accent/10" : "border-zinc-700",
        )}
      >
        <p className="text-zinc-300">Drop photos here, or</p>
        <Button variant="primary" onClick={() => input.current?.click()}>
          Choose photos
        </Button>
        <p className="text-xs text-zinc-500">JPEG, PNG, WebP or iPhone HEIC · up to 25 MB each</p>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {!!active.length && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" aria-label="Uploads">
          {items.map((i) => (
            <li key={i.key} className="relative aspect-square overflow-hidden rounded-lg bg-zinc-800">
              {i.preview && <img src={i.preview} alt="" className="h-full w-full object-cover opacity-60" />}
              <div className="absolute inset-x-0 bottom-0 space-y-1 bg-black/70 p-1.5 text-[11px]">
                <div className="truncate">{i.name}</div>
                {i.status === "error" ? (
                  <div className="flex items-center justify-between gap-1 text-red-400">
                    <span className="truncate">{i.error}</span>
                    <button className="underline" onClick={() => retry(i)}>
                      Retry
                    </button>
                  </div>
                ) : (
                  <div className="h-1 overflow-hidden rounded bg-zinc-700">
                    <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(i.progress * 100)}%` }} />
                  </div>
                )}
              </div>
              {i.status === "done" && <span className="absolute right-1 top-1 rounded bg-green-600 px-1 text-xs">✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
