import exifr from "exifr";

export const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PX = 4096;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

export const isHeic = (f: File) => /image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);

/** HEIC → JPEG, read the EXIF date, shrink anything over 4096 px. */
export async function prepareFile(file: File): Promise<{ blob: Blob; takenAt: string | null; type: string }> {
  let blob: Blob = file;
  let type = file.type;
  let takenAt: string | null = null;
  try {
    const exif = await exifr.parse(file, ["DateTimeOriginal", "CreateDate"]);
    const d = exif?.DateTimeOriginal ?? exif?.CreateDate;
    if (d instanceof Date && !Number.isNaN(d.getTime())) takenAt = d.toISOString();
  } catch {
    /* no EXIF */
  }
  if (isHeic(file)) {
    const { default: heic2any } = await import("heic2any");
    const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
    blob = Array.isArray(out) ? out[0]! : out;
    type = "image/jpeg";
  }
  if (!ACCEPTED.includes(type)) throw new Error("Only JPEG, PNG, WebP and HEIC photos are supported");

  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    if (Math.max(bmp.width, bmp.height) > MAX_PX) {
      const scale = MAX_PX / Math.max(bmp.width, bmp.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Resize failed"))), "image/jpeg", 0.9));
      type = "image/jpeg";
    }
    bmp.close();
  } catch {
    /* leave as is; the server checks it */
  }
  if (blob.size > MAX_BYTES) throw new Error("Photo is larger than 25 MB");
  return { blob, takenAt, type };
}

export class UploadError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

/** One file per request, raw body, with progress. */
export function sendPhoto(concertId: string, blob: Blob, type: string, takenAt: string | null, onProgress: (p: number) => void) {
  return new Promise<{ id: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/concerts/${concertId}/photos`);
    xhr.setRequestHeader("content-type", type);
    if (takenAt) xhr.setRequestHeader("x-taken-at", takenAt);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: { error?: string; id?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status === 201) resolve(body as { id: string });
      else reject(new UploadError(body.error ?? `Upload failed (${xhr.status})`, xhr.status >= 500 && xhr.status !== 507));
    };
    xhr.onerror = () => reject(new UploadError("Network error", true));
    xhr.send(blob);
  });
}
