import { readTextFile, readFile as readBinFile, writeTextFile, readDir, exists, stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type { ToolDefinition, ToolResultContent } from '../../../types';
import { isWindows } from '../../../utils/platform';
import { ensureParentDir } from '../../../utils/pathUtils';
import { isSandboxEnabled, isNetworkIsolationEnabled } from '../../sandbox/config';
import { isCatastrophicDeleteTarget } from '../pathSafety';
import {
  getFileExtension,
  IMAGE_EXTENSIONS,
  IMAGE_MEDIA_TYPES,
  resizeImageIfNeeded,
  OFFICE_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  extractOfficeText,
  listArchiveContents,
  similarityScore,
  type CommandOutput,
} from '../helpers/toolHelpers';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';
import { bindWorkspaceFromWrite } from '../../agent/defaultWorkspace';
import { snapshotBeforeAiEdit } from '@/utils/aiEditSnapshots';

/**
 * Simple pessimistic file lock for concurrent agent safety.
 * Prevents two agents from writing the same file simultaneously.
 * Lock is held only during the write operation (not across turns).
 */
const fileLocks = new Map<string, string>(); // normalized path → loopId

function acquireFileLock(path: string, loopId?: string): string | null {
  const normalized = path.replace(/\\/g, '/');
  const holder = fileLocks.get(normalized);
  if (holder && loopId && holder !== loopId) {
    return holder; // Return the holder's loopId (conflict)
  }
  if (loopId) fileLocks.set(normalized, loopId);
  return null; // Lock acquired
}

function releaseFileLock(path: string): void {
  fileLocks.delete(path.replace(/\\/g, '/'));
}

/** Max file size (bytes) for full text reads without offset/limit. */
const MAX_TEXT_READ_SIZE = 256 * 1024; // 256 KB

/** Default number of lines to read when file exceeds size limit. */
const DEFAULT_LINE_LIMIT = 2000;

// Python source read by pdfplumber strategy. The file path is passed as
// argv[1] — never via string interpolation — so any characters in the path
// (quotes, $(...), backticks) cannot be parsed as Python or shell code.
const PDFPLUMBER_SCRIPT = `import sys, pdfplumber
pdf = pdfplumber.open(sys.argv[1])
print(chr(10).join((p.extract_text() or '') for p in pdf.pages))
pdf.close()`;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export const readFileTool: ToolDefinition = {
  name: TOOL_NAMES.READ_FILE,
  description: 'Read file contents. Supports text files, images (png/jpg/gif/webp — returns visual content), PDFs (text extraction), Office documents (.docx/.xlsx/.pptx — text extraction), and archives (.zip/.tar.gz — lists contents). Text files support offset (start line) and limit (line count) parameters for paginated reading.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file to read' },
      offset: { type: 'number', description: 'Line number to start reading from (0-based). Only use when the file is too large to read at once.' },
      limit: { type: 'number', description: 'Number of lines to read. Only use when the file is too large to read at once.' },
    },
    required: ['path'],
  },
  execute: async (input, context) => {
    const filePath = input.path as string;
    const ext = getFileExtension(filePath);
    const offset = typeof input.offset === 'number' ? Math.max(0, Math.floor(input.offset)) : undefined;
    const limit = typeof input.limit === 'number' ? Math.max(1, Math.floor(input.limit)) : undefined;

    try {
      // --- Image files: return as vision content ---
      if (IMAGE_EXTENSIONS.has(ext)) {
        const mediaType = IMAGE_MEDIA_TYPES[ext] || 'image/png';
        // Non-vision models can't consume image content: a base64 block both
        // bloats context and gets rejected (400) by text-only providers (e.g.
        // GLM: "messages.content.type 取值范围 ['text']"). Skip the read and
        // return a text note so the model can inform the user gracefully.
        if (context?.supportsVision === false) {
          return format(getI18n().toolResult.file.imageSkipNoVision, { path: filePath, mediaType });
        }
        const bytes = new Uint8Array(await readBinFile(filePath));
        const { data, resized } = await resizeImageIfNeeded(bytes, 1280);
        const sizeKB = Math.round(bytes.length / 1024);
        const resizeNote = resized ? ' (auto-resized to 1280px width)' : '';

        return [
          { type: 'text', text: `Image: ${filePath} (${sizeKB}KB, ${mediaType})${resizeNote}` },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        ] as ToolResultContent[];
      }

      // --- PDF files: extract text ---
      if (ext === '.pdf') {
        // Strategy 1: pdftotext (macOS/Linux — fast, native)
        if (!isWindows()) {
          try {
            const output = await invoke<CommandOutput>('run_argv_command', {
              program: 'pdftotext',
              args: [filePath, '-'],
              timeout: 30,
            });
            if (output.code === 0 && output.stdout.trim()) {
              return output.stdout;
            }
          } catch { /* fall through to Python */ }
        }

        // Strategy 2: Python pdfplumber (cross-platform)
        try {
          const pyBin = isWindows() ? 'python' : 'python3';
          const output = await invoke<CommandOutput>('run_argv_command', {
            program: pyBin,
            args: ['-c', PDFPLUMBER_SCRIPT, filePath],
            timeout: 30,
          });
          if (output.code === 0 && output.stdout.trim()) {
            return output.stdout;
          }
        } catch { /* fall through to hint */ }

        // Strategy 3: User hint
        return isWindows()
          ? 'Error: Cannot read PDF as text. Please install Python and run: pip install pdfplumber'
          : 'Error: Cannot read PDF as text. Install pdftotext (brew install poppler) or: pip3 install pdfplumber';
      }

      // --- Office documents: extract text via Python ---
      if (OFFICE_EXTENSIONS.has(ext)) {
        return await extractOfficeText(filePath, ext);
      }

      // --- Archives: list contents ---
      if (ARCHIVE_EXTENSIONS.has(ext) || filePath.endsWith('.tar.gz')) {
        const archiveExt = filePath.endsWith('.tar.gz') ? '.tar.gz' : ext;
        return await listArchiveContents(filePath, archiveExt);
      }

      // --- Text files: read as UTF-8 with size gating and pagination ---
      const fileStat = await stat(filePath);
      const fileSize = fileStat.size;
      const hasRange = offset !== undefined || limit !== undefined;

      // File exceeds size limit and no range specified → reject with guidance
      if (fileSize > MAX_TEXT_READ_SIZE && !hasRange) {
        // Still read a small portion to count total lines via a fast heuristic
        const fullContent = await readTextFile(filePath);
        const totalLines = fullContent.split('\n').length;
        return `File is too large to read at once (${formatSize(fileSize)}, ${totalLines} lines). ` +
          `Use offset and limit parameters to read specific portions, or use search_files to find relevant content.\n` +
          `Example: read_file(path, offset=0, limit=${DEFAULT_LINE_LIMIT}) to read the first ${DEFAULT_LINE_LIMIT} lines.`;
      }

      const content = await readTextFile(filePath);
      const allLines = content.split('\n');
      const totalLines = allLines.length;

      // Apply offset/limit if specified
      if (hasRange) {
        const startLine = offset ?? 0;
        const lineCount = limit ?? DEFAULT_LINE_LIMIT;
        const sliced = allLines.slice(startLine, startLine + lineCount);
        const numLines = sliced.length;
        const header = `[File: ${filePath} | ${formatSize(fileSize)} | Lines ${startLine}-${startLine + numLines - 1} of ${totalLines} total]`;
        return `${header}\n${sliced.join('\n')}`;
      }

      return content;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: true,
};

/**
 * Ensure an HTML document declares UTF-8 so browsers/webviews don't fall back to a
 * locale-default encoding (e.g. GBK on Chinese systems) and mojibake CJK content.
 * writeTextFile always writes UTF-8 bytes; this makes the file self-declare it, which
 * also covers opening the file directly in an external browser (file://, where there
 * is no HTTP charset header to rely on).
 */
function ensureHtmlCharset(content: string): string {
  // Already declares an encoding (meta charset / http-equiv) or has a BOM — leave as-is.
  if (/<meta[^>]*charset/i.test(content) || content.startsWith('\uFEFF')) {
    return content;
  }
  const meta = '<meta charset="utf-8">';
  const headMatch = content.match(/<head[^>]*>/i);
  if (headMatch && headMatch.index !== undefined) {
    const idx = headMatch.index + headMatch[0].length;
    return content.slice(0, idx) + '\n    ' + meta + content.slice(idx);
  }
  const htmlMatch = content.match(/<html[^>]*>/i);
  if (htmlMatch && htmlMatch.index !== undefined) {
    const idx = htmlMatch.index + htmlMatch[0].length;
    return content.slice(0, idx) + `\n<head>${meta}</head>` + content.slice(idx);
  }
  // Fragment / no document structure — a BOM guarantees UTF-8 decoding.
  return '\uFEFF' + content;
}

export const writeFileTool: ToolDefinition = {
  name: TOOL_NAMES.WRITE_FILE,
  description: 'Write content to a file. Creates the file if it does not exist; overwrites if it does. Use only for creating new files — partial edits to existing files must use edit_file (full overwrite will lose sections not explicitly changed). Supports plain text only; cannot create binary files (.docx/.xlsx etc.).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file to write' },
      content: { type: 'string', description: 'Content to write to the file' },
    },
    required: ['path', 'content'],
  },
  execute: async (input, context) => {
    const path = input.path as string;
    const content = input.content as string;

    // Guard: reject binary formats with helpful error message
    const binaryExts = ['.docx', '.xlsx', '.pptx', '.zip', '.pdf', '.png', '.jpg', '.gif'];
    const ext = getFileExtension(path);
    if (binaryExts.includes(ext)) {
      return `Error: write_file only writes plain text. Cannot create ${ext} files directly. ` +
        `Use run_command to execute a script that generates the binary file programmatically.`;
    }

    // File lock: prevent concurrent writes from different agents
    const lockConflict = acquireFileLock(path, context?.loopId);
    if (lockConflict) {
      return format(getI18n().toolResult.file.errFileLocked, { path });
    }

    try {
      await ensureParentDir(path);
      // Add UTF-8 BOM for CSV files so Excel opens them with correct encoding
      let finalContent = content;
      if (ext === '.csv' && !content.startsWith('\uFEFF')) {
        finalContent = '\uFEFF' + content;
      } else if (ext === '.html' || ext === '.htm') {
        finalContent = ensureHtmlCharset(content);
      }
      // Pre-edit snapshot: capture the on-disk "before" state so this AI turn
      // shows up in the preview panel's version history. Fail-open — the
      // helper never throws and must not delay-fail the write.
      await snapshotBeforeAiEdit(path, {
        loopId: context?.loopId,
        conversationId: context?.conversationId,
      });
      await writeTextFile(path, finalContent);
      // Lazily bind a managed default workspace on the first write under ~/Abu/
      // (fire-and-forget — must never affect the write result).
      void bindWorkspaceFromWrite(context?.conversationId, path);
      return `Successfully wrote ${content.length} characters to ${path}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      releaseFileLock(path);
    }
  },
  isConcurrencySafe: false,
};

export const editFileTool: ToolDefinition = {
  name: TOOL_NAMES.EDIT_FILE,
  description: 'Edit a file via exact-match replacement. Use for partial file edits; safer than write_file. old_content must exactly match the text in the file, including whitespace and indentation.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file to edit' },
      old_content: { type: 'string', description: 'The exact text to find and replace (must match exactly, including whitespace and indentation)' },
      new_content: { type: 'string', description: 'The new text to replace old_content with' },
    },
    required: ['path', 'old_content', 'new_content'],
  },
  execute: async (input, context) => {
    const path = input.path as string;
    const oldContent = input.old_content as string;
    const newContent = input.new_content as string;

    // File lock: prevent concurrent edits from different agents
    const lockConflict = acquireFileLock(path, context?.loopId);
    if (lockConflict) {
      return format(getI18n().toolResult.file.errFileLocked, { path });
    }

    try {
      // Check file exists
      if (!(await exists(path))) {
        return `Error: File not found: ${path}`;
      }

      const content = await readTextFile(path);

      // Count occurrences
      const occurrences = content.split(oldContent).length - 1;

      if (occurrences === 0) {
        // Find most similar line to help the user
        const oldLines = oldContent.split('\n');
        const fileLines = content.split('\n');
        let bestMatch = '';
        let bestScore = 0;

        for (const fileLine of fileLines) {
          for (const oldLine of oldLines) {
            if (!oldLine.trim()) continue;
            const score = similarityScore(fileLine.trim(), oldLine.trim());
            if (score > bestScore) {
              bestScore = score;
              bestMatch = fileLine;
            }
          }
        }

        let hint = '';
        if (bestScore > 0.5) {
          hint = `\nMost similar line found:\n"${bestMatch.trim()}"`;
        }
        return `Error: old_content not found in file. Make sure it matches exactly, including whitespace and indentation.${hint}`;
      }

      if (occurrences > 1) {
        return `Error: old_content matches ${occurrences} locations. Please provide more surrounding context to make the match unique.`;
      }

      // Pre-edit snapshot (validation passed — we are definitely writing).
      // Reuses the already-read `content`, so no extra disk read.
      await snapshotBeforeAiEdit(path, {
        loopId: context?.loopId,
        conversationId: context?.conversationId,
        knownContent: content,
      });

      // Perform replacement. Use a function replacer so new_content is inserted
      // verbatim — a string replacement would let JS interpret `$$`, `$&`,
      // `` $` ``, `$'` in new_content as special patterns (even with a string
      // search), silently corrupting any content containing a literal `$`.
      const updated = content.replace(oldContent, () => newContent);
      await writeTextFile(path, updated);

      const oldLines = oldContent.split('\n').length;
      const newLines = newContent.split('\n').length;
      return `Successfully edited ${path}: replaced ${oldLines} line(s) with ${newLines} line(s)`;
    } catch (err) {
      return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      releaseFileLock(path);
    }
  },
  isConcurrencySafe: false,
};

export const deleteFileTool: ToolDefinition = {
  name: TOOL_NAMES.DELETE_FILE,
  description:
    'Move a file or directory to the operating-system Trash (recoverable) instead of ' +
    'deleting it permanently. ALWAYS prefer this over running `rm` through run_command: ' +
    '`rm` deletes permanently and cannot be undone, whereas delete_file lands the entry in ' +
    "the user's Trash. Before calling, tell the user exactly what you are about to delete " +
    'and get their confirmation.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file or directory to move to Trash' },
    },
    required: ['path'],
  },
  execute: async (input) => {
    const path = input.path as string;
    // Hard block — enforced regardless of permission mode. checkWritePath alone only
    // returns needsPermission:true for the filesystem root / home dir, which resolves
    // to an automatic ALLOW in autonomous mode. Fail-closed: never call move_to_trash.
    if (await isCatastrophicDeleteTarget(path)) {
      return format(getI18n().toolResult.file.deleteRefusedCatastrophic, { path });
    }
    try {
      await invoke('move_to_trash', { path });
      return format(getI18n().toolResult.file.movedToTrash, { path });
    } catch (err) {
      // Fail-closed: never fall back to a permanent delete.
      return format(getI18n().toolResult.file.trashFailed, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
  isConcurrencySafe: false,
};

export const listDirectoryTool: ToolDefinition = {
  name: TOOL_NAMES.LIST_DIRECTORY,
  description: 'List directory contents. Returns file and subdirectory names with their types, sorted alphabetically.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the directory to list' },
    },
    required: ['path'],
  },
  execute: async (input) => {
    const dirPath = input.path as string;

    try {
      const entries = await readDir(dirPath);
      if (entries.length === 0) {
        return `Directory "${dirPath}" is empty.`;
      }

      // Sort alphabetically (case-insensitive)
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

      const lines = entries.map((entry) => {
        const type = entry.isDirectory ? '[DIR]' : '[FILE]';
        return `${type} ${entry.name}`;
      });
      return lines.join('\n');
    } catch (err) {
      return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: true,
};

export const searchFilesTool: ToolDefinition = {
  name: TOOL_NAMES.SEARCH_FILES,
  description: 'Search file contents in a directory (similar to grep). Use this to search file contents; use find_files to search by file name. Returns matching lines with their file paths and line numbers.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The text or regex pattern to search for' },
      path: { type: 'string', description: 'Directory to search in (absolute path)' },
      include: { type: 'string', description: 'File glob pattern to include (e.g., "*.ts", "*.py")' },
      max_results: { type: 'number', description: 'Maximum number of matching lines to return (default 50)' },
    },
    required: ['pattern', 'path'],
  },
  execute: async (input) => {
    const pattern = input.pattern as string;
    const searchPath = input.path as string;
    const include = input.include as string | undefined;
    const safeMaxResults = Math.min(Math.max(1, Math.floor(Number(input.max_results) || 50)), 500);

    // Sanitize inputs to prevent injection (strip newlines then escape quotes)
    const safePattern = pattern.replace(/[\n\r]/g, ' ').replace(/'/g, "'\\''");
    const safePath = searchPath.replace(/[\n\r]/g, ' ').replace(/'/g, "'\\''");

    let command: string;
    if (isWindows()) {
      // Windows: use PowerShell for recursive grep-like search
      const psPattern = pattern.replace(/[\n\r]/g, ' ').replace(/'/g, "''");
      const psPath = searchPath.replace(/[\n\r]/g, ' ').replace(/'/g, "''");
      const includeFilter = include
        ? ` -Include '${include.replace(/'/g, "''")}'`
        : '';
      command = `Get-ChildItem -Path '${psPath}' -Recurse -File${includeFilter} | Select-String -Pattern '${psPattern}' | Select-Object -First ${safeMaxResults}`;
    } else {
      command = `grep -rn --color=never '${safePattern}' '${safePath}'`;
      if (include) {
        const safeInclude = include.replace(/[\n\r]/g, ' ').replace(/'/g, "'\\''");
        command = `grep -rn --color=never --include='${safeInclude}' '${safePattern}' '${safePath}'`;
      }
      command += ` | head -n ${safeMaxResults}`;
    }

    try {
      const output = await invoke<CommandOutput>('run_shell_command', {
        command,
        cwd: null,
        background: false,
        timeout: 15,
        sandboxEnabled: isSandboxEnabled(),
        networkIsolation: isNetworkIsolationEnabled(),
        extraWritablePaths: [],
      });

      if (output.stdout.trim()) {
        const cleaned = output.stdout.replace(/\r\n/g, '\n').trim();
        const lines = cleaned.split('\n');
        return `Found ${lines.length}${lines.length >= safeMaxResults ? '+' : ''} matches:\n${cleaned}`;
      }
      if (output.code === 1) {
        return 'No matches found.';
      }
      if (output.stderr.trim()) {
        return `Error: ${output.stderr.trim()}`;
      }
      return 'No matches found.';
    } catch (err) {
      return `Error searching files: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: true,
};

export const findFilesTool: ToolDefinition = {
  name: TOOL_NAMES.FIND_FILES,
  description: 'Find files by name pattern (similar to the find command). Use this to search by file name; use search_files to search file contents. Returns a list of matching file paths.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'File name pattern to search for (glob, e.g., "*.ts", "*.py", "README*")' },
      path: { type: 'string', description: 'Directory to search in (absolute path)' },
      max_results: { type: 'number', description: 'Maximum number of results to return (default 100)' },
    },
    required: ['pattern', 'path'],
  },
  execute: async (input) => {
    const pattern = input.pattern as string;
    const searchPath = input.path as string;
    const safeMaxResults = Math.min(Math.max(1, Math.floor(Number(input.max_results) || 100)), 500);

    // Sanitize inputs (strip newlines then escape quotes)
    const safePattern = pattern.replace(/[\n\r]/g, ' ').replace(/'/g, "'\\''");
    const safePath = searchPath.replace(/[\n\r]/g, ' ').replace(/'/g, "'\\''");

    let command: string;
    if (isWindows()) {
      // Windows: use PowerShell for recursive file find
      const psPattern = pattern.replace(/[\n\r]/g, ' ').replace(/'/g, "''");
      const psPath = searchPath.replace(/[\n\r]/g, ' ').replace(/'/g, "''");
      command = `Get-ChildItem -Path '${psPath}' -Recurse -Name -Include '${psPattern}' | Where-Object { $_ -notlike '*\\node_modules\\*' -and $_ -notlike '*\\.git\\*' } | Select-Object -First ${safeMaxResults}`;
    } else {
      command = `find '${safePath}' -name '${safePattern}' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -n ${safeMaxResults}`;
    }

    try {
      const output = await invoke<CommandOutput>('run_shell_command', {
        command,
        cwd: null,
        background: false,
        timeout: 15,
        sandboxEnabled: isSandboxEnabled(),
        networkIsolation: isNetworkIsolationEnabled(),
        extraWritablePaths: [],
      });

      if (output.stdout.trim()) {
        const cleaned = output.stdout.replace(/\r\n/g, '\n').trim();
        const lines = cleaned.split('\n');
        return `Found ${lines.length}${lines.length >= safeMaxResults ? '+' : ''} files:\n${cleaned}`;
      }
      return 'No files found matching the pattern.';
    } catch (err) {
      return `Error finding files: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: true,
};
