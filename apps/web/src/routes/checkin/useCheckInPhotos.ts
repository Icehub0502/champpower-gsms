import { useEffect, useRef, useState } from 'react';
import type { UploadedFile } from '@gsms/contracts/index.js';
import { ApiError, api } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';
import { resizeImageToBlob } from '../../lib/compressImage';

/** The contract's cap: CheckInInput.photoFileIds.max(30). */
export const MAX_PHOTOS = 30;

export interface CheckInPhoto {
  key: string;
  /** Local preview of the ORIGINAL pick — shown while it uploads. */
  previewUrl: string;
  /**
   * needs_auth: the upload was refused with 401 because the session is gone
   * (the shared refresh came back negative). NOT a failure of this photo —
   * it is kept, with its source, and resent by retryAuth() once signed in.
   */
  status: 'uploading' | 'done' | 'failed' | 'needs_auth';
  fileId?: string;
  /** Kept so a failed upload can be retried without picking again. */
  source: File;
}

let seq = 0;

/**
 * Check-in photos: camera and gallery feed ONE list (decision 1). Each pick is
 * resized on the client and uploaded straight away as `checkin_photo`
 * (POST /api/files, multipart via api.upload); the form then sends the
 * finished ids as `photoFileIds`, in list order — the first is the cover.
 *
 * A failed upload stays in the list, marked, with retry/remove — it never
 * clears the form or the other photos. `pending`/`failed` let the page hold the
 * submit until every photo has either landed or been removed, so a photo is
 * never silently dropped from the job.
 */
export function useCheckInPhotos() {
  const [photos, setPhotos] = useState<CheckInPhoto[]>([]);
  const alive = useRef(true);
  const urls = useRef(new Set<string>());

  useEffect(() => {
    alive.current = true;
    const owned = urls.current;
    return () => {
      alive.current = false;
      owned.forEach((u) => URL.revokeObjectURL(u));
      owned.clear();
    };
  }, []);

  function patch(key: string, change: Partial<CheckInPhoto>) {
    if (!alive.current) return;
    setPhotos((list) => list.map((p) => (p.key === key ? { ...p, ...change } : p)));
  }

  async function upload(key: string, source: File) {
    patch(key, { status: 'uploading' });
    try {
      const blob = await resizeImageToBlob(source);
      const fd = new FormData();
      fd.append('kind', 'checkin_photo');
      fd.append('file', blob, 'checkin.jpg');
      const uploaded = await api.upload<UploadedFile>('/api/files', fd);
      patch(key, { status: 'done', fileId: uploaded.id });
    } catch (err) {
      if (isSessionCancelled(err)) return; // session ended: not a failed photo
      // Several photos uploading together all get their own 401 when one
      // shared refresh fails; each is marked needs_auth and the screen shows
      // ONE session message for all of them, not a stack of photo errors.
      patch(key, { status: err instanceof ApiError && err.status === 401 ? 'needs_auth' : 'failed' });
    }
  }

  function add(files: FileList | File[] | null) {
    if (!files) return;
    const room = MAX_PHOTOS - photos.length;
    const picked = Array.from(files).slice(0, Math.max(0, room));
    const added = picked.map((source): CheckInPhoto => {
      const previewUrl = URL.createObjectURL(source);
      urls.current.add(previewUrl);
      return { key: `p${++seq}`, previewUrl, status: 'uploading', source };
    });
    setPhotos((list) => [...list, ...added]);
    for (const p of added) void upload(p.key, p.source);
  }

  function remove(key: string) {
    setPhotos((list) => {
      const gone = list.find((p) => p.key === key);
      if (gone) {
        URL.revokeObjectURL(gone.previewUrl);
        urls.current.delete(gone.previewUrl);
      }
      return list.filter((p) => p.key !== key);
    });
  }

  function move(key: string, delta: -1 | 1) {
    setPhotos((list) => {
      const i = list.findIndex((p) => p.key === key);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const next = list.slice();
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  function retry(key: string) {
    const p = photos.find((x) => x.key === key);
    if (p) void upload(p.key, p.source);
  }

  /** Resend every photo held back by an expired session, in one go. */
  function retryAuth() {
    for (const p of photos) if (p.status === 'needs_auth') void upload(p.key, p.source);
  }

  return {
    photos,
    retryAuth,
    sessionExpired: photos.some((p) => p.status === 'needs_auth'),
    add,
    remove,
    move,
    retry,
    fileIds: photos.filter((p) => p.status === 'done' && p.fileId).map((p) => p.fileId!),
    pending: photos.some((p) => p.status === 'uploading'),
    failed: photos.some((p) => p.status === 'failed'),
    full: photos.length >= MAX_PHOTOS,
  };
}
