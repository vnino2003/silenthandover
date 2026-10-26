export interface PhotoUpload {
  content_type: 'image/jpeg';
  data_base64: string;
  preview: string;
}

const MAX_SIDE = 1600;
const MAX_BYTES = 2_800_000;

/** Shrinks a phone photo to at most 1600 px and re-encodes it as JPEG, so uploads stay small. */
export async function preparePhoto(file: File): Promise<PhotoUpload> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That photo could not be opened'));
      el.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    let quality = 0.82;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length * 0.75 > MAX_BYTES && quality > 0.4) {
      quality -= 0.12;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    if (dataUrl.length * 0.75 > MAX_BYTES) throw new Error('That photo is too large');
    return { content_type: 'image/jpeg', data_base64: dataUrl.slice(dataUrl.indexOf(',') + 1), preview: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Crops a picture to a centred square and shrinks it to 320 px, for profile pictures. */
export async function prepareAvatar(file: File): Promise<PhotoUpload> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a picture');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That picture could not be opened'));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const out = Math.min(320, side);
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out, out);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    return { content_type: 'image/jpeg', data_base64: dataUrl.slice(dataUrl.indexOf(',') + 1), preview: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}
