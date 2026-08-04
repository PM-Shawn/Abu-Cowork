import { copyFile, writeTextFile } from '@tauri-apps/plugin-fs';

/**
 * Save a preview copy without losing a debounced editor draft. Binary/read-only
 * previews copy the source bytes; editable previews write the current buffer.
 */
export async function savePreviewCopy({
  sourcePath,
  destinationPath,
  currentText,
}: {
  sourcePath: string;
  destinationPath: string;
  currentText?: string;
}): Promise<void> {
  if (currentText !== undefined) {
    await writeTextFile(destinationPath, currentText);
    return;
  }
  await copyFile(sourcePath, destinationPath);
}
