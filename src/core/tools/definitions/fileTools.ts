import { readTextFile, readFile as readBinFile, writeTextFile, readDir, exists } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type { ToolDefinition, ToolResultContent } from '../../../types';
import { isWindows } from '../../../utils/platform';
import { ensureParentDir } from '../../../utils/pathUtils';
import { isSandboxEnabled, isNetworkIsolationEnabled } from '../../sandbox/config';
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

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: '读取文件内容。支持文本文件、图片（png/jpg/gif/webp，返回视觉内容）、PDF（提取文字）、Office 文档（.docx/.xlsx/.pptx，提取文字）和压缩包（.zip/.tar.gz，列出内容）。返回文件内容或提取的文本。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file to read' },
    },
    required: ['path'],
  },
  execute: async (input) => {
    const filePath = input.path as string;
    const ext = getFileExtension(filePath);

    try {
      // --- Image files: return as vision content ---
      if (IMAGE_EXTENSIONS.has(ext)) {
        const bytes = new Uint8Array(await readBinFile(filePath));
        const mediaType = IMAGE_MEDIA_TYPES[ext] || 'image/png';
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
            const output = await invoke<CommandOutput>('run_shell_command', {
              command: `pdftotext "${filePath}" -`,
              cwd: null,
              background: false,
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
          const escapedPath = isWindows()
            ? filePath.replace(/'/g, "''")
            : filePath.replace(/'/g, "'\\''");
          const pyCmd = `${pyBin} -c "import pdfplumber; pdf=pdfplumber.open('${escapedPath}'); print('\\n'.join(p.extract_text() or '' for p in pdf.pages)); pdf.close()"`;
          const output = await invoke<CommandOutput>('run_shell_command', {
            command: pyCmd,
            cwd: null,
            background: false,
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

      // --- Text files: read as UTF-8 ---
      const content = await readTextFile(filePath);
      return content;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: '将内容写入文件。文件不存在则创建，已存在则覆盖。创建新文件或完整覆写时使用，局部修改用 edit_file。仅支持纯文本，不能创建二进制文件（.docx/.xlsx 等）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file to write' },
      content: { type: 'string', description: 'Content to write to the file' },
    },
    required: ['path', 'content'],
  },
  execute: async (input) => {
    const path = input.path as string;
    const content = input.content as string;

    // Guard: reject binary formats with helpful error message
    const binaryExts = ['.docx', '.xlsx', '.pptx', '.zip', '.pdf', '.png', '.jpg', '.gif'];
    const ext = getFileExtension(path);
    if (binaryExts.includes(ext)) {
      return `Error: write_file only writes plain text. Cannot create ${ext} files directly. ` +
        `Use run_command to execute a script that generates the binary file programmatically.`;
    }

    try {
      await ensureParentDir(path);
      // Add UTF-8 BOM for CSV files so Excel opens them with correct encoding
      let finalContent = content;
      if (ext === '.csv' && !content.startsWith('\uFEFF')) {
        finalContent = '\uFEFF' + content;
      }
      await writeTextFile(path, finalContent);
      return `Successfully wrote ${content.length} characters to ${path}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: '通过精确匹配替换来编辑文件。局部修改文件时使用，比 write_file 更安全。old_content 必须与文件中的文本完全匹配（包括空白和缩进）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file to edit' },
      old_content: { type: 'string', description: 'The exact text to find and replace (must match exactly, including whitespace and indentation)' },
      new_content: { type: 'string', description: 'The new text to replace old_content with' },
    },
    required: ['path', 'old_content', 'new_content'],
  },
  execute: async (input) => {
    const path = input.path as string;
    const oldContent = input.old_content as string;
    const newContent = input.new_content as string;

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

      // Perform replacement
      const updated = content.replace(oldContent, newContent);
      await writeTextFile(path, updated);

      const oldLines = oldContent.split('\n').length;
      const newLines = newContent.split('\n').length;
      return `Successfully edited ${path}: replaced ${oldLines} line(s) with ${newLines} line(s)`;
    } catch (err) {
      return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description: '列出目录内容。返回文件和子目录名称及类型，按字母排序。',
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
};

export const searchFilesTool: ToolDefinition = {
  name: 'search_files',
  description: '在目录中搜索文件内容（类似 grep）。搜索文件内容用这个，搜索文件名用 find_files。返回匹配行及其文件路径和行号。',
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
};

export const findFilesTool: ToolDefinition = {
  name: 'find_files',
  description: '按文件名模式查找文件（类似 find 命令）。搜索文件名用这个，搜索文件内容用 search_files。返回匹配的文件路径列表。',
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
};
