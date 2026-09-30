/** Resizes+compresses a picked photo client-side into a small JPEG data URL — small
 * enough to store directly on the job document, so a photo cover shot works without
 * a Storage bucket. */
export function compressImage(file: File, maxDim = 640, quality = 0.62): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Resizes a picked photo on the client and returns a JPEG Blob for a multipart
 * upload (api.upload -> POST /api/files). Never base64: a data URL is a third
 * larger on the wire and the server stores files on disk, not in a column.
 *
 * 1600px on the long edge, not compressImage's 640: a check-in photo is the
 * evidence of the car's condition when it arrived (DECISION-7-today.md §2), and
 * a scratch has to still be visible at that size. Still small enough for a
 * phone on garage Wi-Fi. Never upscales.
 */
export function resizeImageToBlob(file: Blob, maxDim = 1600, quality = 0.8): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image_decode_failed'));
    };
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('canvas_unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode_failed'))), 'image/jpeg', quality);
    };
    img.src = url;
  });
}
