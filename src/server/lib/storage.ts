import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Photo storage. Features only talk to this interface, so the Docker-volume driver
 * can be swapped for S3/R2 later without touching them.
 */
export interface Storage {
  /** Streams `body` to `key`. Aborts and removes the partial file if more than `maxBytes` arrive. Returns bytes written. */
  put(key: string, body: ReadableStream<Uint8Array> | Readable | Buffer, opts?: { maxBytes?: number }): Promise<number>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Promise<{ stream: Readable; size: number } | null>;
  delete(key: string): Promise<void>;
  /** Removes every key under a prefix (e.g. a photo's original + thumbnails). */
  deletePrefix(prefix: string): Promise<void>;
  /** Disk usage of the volume, for the admin page. */
  disk(): Promise<{ total: number; free: number } | null>;
}

export class TooLargeError extends Error {
  constructor(public maxBytes: number) {
    super(`File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
}

export class VolumeStorage implements Storage {
  constructor(private root: string) {}

  private file(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return full;
  }

  async put(key: string, body: ReadableStream<Uint8Array> | Readable | Buffer, opts: { maxBytes?: number } = {}) {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    const src =
      body instanceof Buffer ? Readable.from([body]) : body instanceof Readable ? body : Readable.fromWeb(body as never);
    let bytes = 0;
    const max = opts.maxBytes ?? Infinity;
    const counter = async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > max) throw new TooLargeError(max);
        yield chunk;
      }
    };
    try {
      await pipeline(src, counter, createWriteStream(file));
    } catch (e) {
      await rm(file, { force: true });
      throw e;
    }
    return bytes;
  }

  async get(key: string) {
    const r = await this.stream(key);
    if (!r) throw new Error(`Not found: ${key}`);
    const chunks: Buffer[] = [];
    for await (const c of r.stream) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  async stream(key: string) {
    const file = this.file(key);
    try {
      const s = await stat(file);
      return { stream: createReadStream(file), size: s.size };
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }

  async deletePrefix(prefix: string) {
    if (prefix.endsWith("/")) {
      await rm(this.file(prefix.slice(0, -1)), { force: true, recursive: true });
      return;
    }
    const dir = path.dirname(this.file(prefix + "x"));
    const base = path.basename(prefix);
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(base)).map((n) => rm(path.join(dir, n), { force: true, recursive: true })));
  }

  async disk() {
    try {
      await mkdir(this.root, { recursive: true });
      const s = await statfs(this.root);
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      return null;
    }
  }
}
