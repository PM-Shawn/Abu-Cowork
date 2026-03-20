import { readFile as readBinFile, writeFile as writeBinFile } from '@tauri-apps/plugin-fs';
import { homeDir, desktopDir, documentDir, downloadDir, tempDir } from '@tauri-apps/api/path';
import { platform } from '@tauri-apps/plugin-os';
import { invoke } from '@tauri-apps/api/core';
import { initPlatform, isWindows } from '../../../utils/platform';
import { extractUsername } from '../../../utils/pathUtils';

export interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

// Cache system info to avoid repeated async calls
let cachedSystemInfo: Record<string, string> | null = null;

export async function getSystemInfoData(): Promise<Record<string, string>> {
  if (cachedSystemInfo) return cachedSystemInfo;

  const [currentPlatform, home, desktop, documents, downloads] = await Promise.all([
    platform(),
    homeDir(),
    desktopDir(),
    documentDir(),
    downloadDir(),
  ]);

  // Initialize platform singleton for synchronous isWindows() checks
  await initPlatform();

  cachedSystemInfo = {
    platform: currentPlatform,
    home,
    desktop,
    documents,
    downloads,
    username: extractUsername(home),
  };

  return cachedSystemInfo;
}

// Image extensions that can be sent as vision content
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};
// Max image size in bytes before auto-resize (2MB)
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Resize an image to fit within maxWidth using system tools.
 * Returns base64 string of the resized image, or null on failure.
 */
export async function resizeImageIfNeeded(bytes: Uint8Array, maxWidth: number): Promise<{ data: string; resized: boolean }> {
  const base64 = uint8ArrayToBase64(bytes);

  if (bytes.length <= IMAGE_MAX_BYTES) {
    return { data: base64, resized: false };
  }

  // Use sips on macOS to resize
  if (!isWindows()) {
    try {
      const tmpDir = await tempDir();
      const tmpPath = `${tmpDir}abu-resize-${Date.now()}.png`;
      await writeBinFile(tmpPath, bytes);
      await invoke<CommandOutput>('run_shell_command', {
        command: `sips --resampleWidth ${maxWidth} "${tmpPath}" --out "${tmpPath}"`,
        cwd: null, background: false, timeout: 15,
      });
      const resized = await readBinFile(tmpPath);
      // Clean up
      invoke<CommandOutput>('run_shell_command', { command: `rm -f "${tmpPath}"`, cwd: null, background: false, timeout: 5 }).catch(() => {});
      return { data: uint8ArrayToBase64(new Uint8Array(resized)), resized: true };
    } catch { /* fall through to original */ }
  }

  return { data: base64, resized: false };
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function getFileExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

// Office document extensions that can be extracted as text
export const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.xls', '.doc']);

// Archive extensions that can be listed
export const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.tar.gz', '.tgz', '.gz', '.7z', '.rar']);

/**
 * Extract text content from Office documents.
 * - .xlsx/.xls: Uses xlsx npm package (already installed, no Python needed)
 * - .docx: Extracts XML text from the docx zip structure (no Python needed)
 * - .pptx: Falls back to Python python-pptx
 */
export async function extractOfficeText(filePath: string, ext: string): Promise<string> {
  if (ext === '.xlsx' || ext === '.xls') {
    return extractXlsxText(filePath);
  }
  if (ext === '.docx') {
    return extractDocxText(filePath);
  }
  if (ext === '.pptx') {
    return extractPptxViaPython(filePath);
  }
  return `Error: Unsupported Office format: ${ext}`;
}

/** Extract Excel text using the xlsx npm package (already in dependencies) */
async function extractXlsxText(filePath: string): Promise<string> {
  try {
    const data = new Uint8Array(await readBinFile(filePath));
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(data, { type: 'array' });
    const lines: string[] = [];

    for (const sheetName of workbook.SheetNames) {
      lines.push(`=== Sheet: ${sheetName} ===`);
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' }) as string[][];
      const maxRows = Math.min(rows.length, 500);
      for (let i = 0; i < maxRows; i++) {
        lines.push(rows[i].map(String).join('\t'));
      }
      if (rows.length > 500) {
        lines.push(`[... ${rows.length - 500} more rows omitted ...]`);
      }
    }
    return lines.join('\n');
  } catch (err) {
    return `Error reading Excel file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Extract Word document text by parsing the docx XML structure (docx = zip of XML files) */
async function extractDocxText(filePath: string): Promise<string> {
  try {
    const data = new Uint8Array(await readBinFile(filePath));
    // docx is a zip file — use fflate to decompress and read word/document.xml
    const { unzipSync } = await import('fflate');
    const unzipped = unzipSync(data);

    // Main document content is in word/document.xml
    const docXml = unzipped['word/document.xml'];
    if (!docXml) {
      return 'Error: Invalid docx file — word/document.xml not found.';
    }

    // Parse XML text content — extract text between <w:t> tags
    const xmlStr = new TextDecoder().decode(docXml);
    const lines: string[] = [];
    let currentParagraph = '';

    // Split by paragraph markers <w:p> and extract text from <w:t> tags
    const paragraphs = xmlStr.split(/<w:p[\s>]/);
    for (const para of paragraphs) {
      const texts: string[] = [];
      const textMatches = para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g);
      for (const match of textMatches) {
        texts.push(match[1]);
      }
      currentParagraph = texts.join('');
      if (currentParagraph.trim()) {
        lines.push(currentParagraph);
      }
    }

    if (lines.length === 0) {
      return 'Document is empty or contains only images/embedded objects.';
    }
    return lines.join('\n');
  } catch (err) {
    return `Error reading Word file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Extract PowerPoint text via Python (python-pptx) — no JS alternative */
async function extractPptxViaPython(filePath: string): Promise<string> {
  const pyBin = isWindows() ? 'python' : 'python3';
  // On Windows, convert backslashes to forward slashes (Python handles both) and
  // escape single quotes for Python; on Unix, escape single quotes for shell.
  const escapedPath = isWindows()
    ? filePath.replace(/\\/g, '/').replace(/'/g, "\\'")
    : filePath.replace(/'/g, "'\\''");

  const pyCmd = `${pyBin} -c "
from pptx import Presentation
prs = Presentation('${escapedPath}')
for i, slide in enumerate(prs.slides, 1):
    print(f'=== Slide {i} ===')
    for shape in slide.shapes:
        if hasattr(shape, 'text') and shape.text:
            print(shape.text)
"`;

  try {
    const output = await invoke<CommandOutput>('run_shell_command', {
      command: pyCmd,
      cwd: null,
      background: false,
      timeout: 30,
    });
    if (output.code === 0 && output.stdout.trim()) {
      return output.stdout;
    }
    if (output.stderr?.includes('ModuleNotFoundError')) {
      return 'Error: Python module not installed. Run: pip3 install python-pptx';
    }
    return `Error extracting pptx: ${output.stderr?.slice(0, 500) || 'Unknown error'}`;
  } catch {
    return `Error: Python3 not available. Install Python and python-pptx to read .pptx files.`;
  }
}

/**
 * List contents of an archive file using system commands.
 */
export async function listArchiveContents(filePath: string, ext: string): Promise<string> {
  let command: string;

  if (ext === '.zip') {
    if (isWindows()) {
      const psPath = filePath.replace(/'/g, "''");
      command = `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead('${psPath}').Entries | Select-Object FullName, Length | Format-Table -AutoSize"`;
    } else {
      command = `unzip -l "${filePath}"`;
    }
  } else if (ext === '.tar' || ext === '.tar.gz' || ext === '.tgz') {
    command = isWindows()
      ? `tar -tf "${filePath}"`
      : `tar -tf "${filePath}"`;
  } else if (ext === '.gz' && !filePath.endsWith('.tar.gz')) {
    command = `file "${filePath}"`;
  } else {
    return `Archive listing not supported for ${ext}. Use run_command to extract.`;
  }

  try {
    const output = await invoke<CommandOutput>('run_shell_command', {
      command,
      cwd: null,
      background: false,
      timeout: 15,
    });
    if (output.code === 0) {
      return output.stdout || 'Archive is empty.';
    }
    return `Error listing archive: ${output.stderr || 'Unknown error'}`;
  } catch {
    return `Error: Could not list archive contents.`;
  }
}

/** Simple similarity score (0-1) based on common characters */
export function similarityScore(a: string, b: string): number {
  if (!a || !b) return 0;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1.0;
  const matchCount = shorter.split('').filter((ch, i) => longer[i] === ch).length;
  return matchCount / longer.length;
}

export const ALLOWED_IMAGE_FORMATS = ['png', 'jpeg', 'jpg', 'gif', 'bmp', 'tiff'];

export function buildMacImageCommand(
  inputPath: string, outputPath: string, action: string, params: Record<string, unknown>
): string {
  // Escape paths for shell
  const safein = inputPath.replace(/'/g, "'\\''");
  const safeout = outputPath.replace(/'/g, "'\\''");

  // First copy input to output, then modify in-place with sips
  const copy = `cp '${safein}' '${safeout}'`;

  switch (action) {
    case 'resize': {
      const w = Number(params.width) || 800;
      const h = Number(params.height) || 600;
      // sips -z resizes to exact height×width without maintaining aspect ratio
      return `${copy} && sips -z ${h} ${w} '${safeout}'`;
    }
    case 'crop': {
      const cw = Number(params.width) || 800;
      const ch = Number(params.height) || 600;
      return `${copy} && sips --cropToHeightWidth ${ch} ${cw} '${safeout}'`;
    }
    case 'convert': {
      const format = ((params.format as string) || 'png').toLowerCase();
      if (!ALLOWED_IMAGE_FORMATS.includes(format)) {
        return `echo 'Unsupported format: use one of ${ALLOWED_IMAGE_FORMATS.join(', ')}'`;
      }
      return `${copy} && sips -s format ${format} '${safeout}' --out '${safeout}'`;
    }
    case 'compress': {
      const quality = Math.max(1, Math.min(100, Number(params.quality) || 80));
      return `${copy} && sips -s format jpeg -s formatOptions ${quality} '${safeout}' --out '${safeout}'`;
    }
    default:
      return `echo 'Unsupported action'`;
  }
}

export function buildWindowsImageCommand(
  inputPath: string, outputPath: string, action: string, params: Record<string, unknown>
): string {
  const psIn = inputPath.replace(/'/g, "''");
  const psOut = outputPath.replace(/'/g, "''");

  switch (action) {
    case 'resize': {
      const w = Number(params.width) || 800;
      const h = Number(params.height) || 600;
      return `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('${psIn}'); $bmp = New-Object System.Drawing.Bitmap(${w}, ${h}); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $g.DrawImage($img, 0, 0, ${w}, ${h}); $bmp.Save('${psOut}'); $g.Dispose(); $bmp.Dispose(); $img.Dispose()"`;
    }
    case 'crop': {
      const x = Number(params.x) || 0;
      const y = Number(params.y) || 0;
      const cw = Number(params.width) || 800;
      const ch = Number(params.height) || 600;
      return `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('${psIn}'); $rect = New-Object System.Drawing.Rectangle(${x}, ${y}, ${cw}, ${ch}); $bmp = ([System.Drawing.Bitmap]$img).Clone($rect, $img.PixelFormat); $bmp.Save('${psOut}'); $bmp.Dispose(); $img.Dispose()"`;
    }
    case 'convert': {
      const format = ((params.format as string) || 'png').toLowerCase();
      const formatMap: Record<string, string> = { png: 'Png', jpg: 'Jpeg', jpeg: 'Jpeg', bmp: 'Bmp', gif: 'Gif' };
      const dotNetFormat = formatMap[format];
      if (!dotNetFormat) {
        return `echo Unsupported format: use one of ${Object.keys(formatMap).join(', ')}`;
      }
      return `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('${psIn}'); $img.Save('${psOut}', [System.Drawing.Imaging.ImageFormat]::${dotNetFormat}); $img.Dispose()"`;
    }
    case 'compress': {
      const quality = Math.max(1, Math.min(100, Number(params.quality) || 80));
      return `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('${psIn}'); $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }; $ep = New-Object System.Drawing.Imaging.EncoderParameters(1); $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, ${quality}L); $img.Save('${psOut}', $codec, $ep); $img.Dispose()"`;
    }
    default:
      return `echo Unsupported action`;
  }
}
