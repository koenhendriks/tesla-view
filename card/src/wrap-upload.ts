/** Limits accepted by the wrap editor, independent of the file's extension/MIME type. */
const MAX_WRAP_BYTES = 9 * 1024 * 1024;
const MAX_WRAP_DIMENSION = 4096;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export async function validateWrapImage(file: File): Promise<void> {
  if (file.size > MAX_WRAP_BYTES) {
    throw new Error('Choose a PNG no larger than 9 MiB.');
  }
  const signature = new Uint8Array(await file.slice(0, PNG_SIGNATURE.length).arrayBuffer());
  if (!PNG_SIGNATURE.every((value, index) => signature[index] === value)) {
    throw new Error('Choose a valid PNG image.');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This PNG could not be read. Try exporting it again.');
  }
  try {
    if (bitmap.width !== bitmap.height || bitmap.width > MAX_WRAP_DIMENSION) {
      throw new Error('Use a square Tesla wrap PNG, up to 4096 × 4096 pixels.');
    }
  } finally {
    bitmap.close();
  }
}
