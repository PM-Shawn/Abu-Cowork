import type { ToolExecutionContext } from '@/types';
import { isWindows } from '@/utils/platform';
import { format, getI18n } from '@/i18n';
import { redactSensitiveMediaText } from '@/core/security/redaction';
import { FileOperationDenied } from '@/core/tools/fileOperation';
import { invokeTaskCommand, isTaskCommandAbortedError } from '../helpers/scopedCommand';
import type { CommandOutput } from '../helpers/toolHelpers';

/**
 * One Python program that looks inside documents for read_file.
 *
 * It runs on the bundled Python (pypdfium2, Pillow) and answers one operation
 * per call with one JSON object on stdout:
 *
 * - `pdf-read`: per-page facts (text amount, garbled or OCR text layer, image
 *   objects and the share of the page they cover, vector paths), the page text,
 *   and JPEG renders of the requested pages (or of every page of a short
 *   document), each with rulers on its top and left edges in page fractions.
 *   An OCR layer whose lines were written in no order (they keep jumping back
 *   up the page) is given as lines sorted by their place on the page; any
 *   other text keeps the order its producer wrote it in.
 *
 * The program never writes a file. It is passed with `python -c`, without its
 * comment lines, so it stays well under the 32,768-character argument limit of
 * the file processor, and it holds no backtick and no `${` (it lives in a raw
 * template literal). The file
 * is its last argument and is read by content, never by name: the file
 * processor hands it a copy named `input`. Its time budgets keep it inside the
 * processor's 30 s limit, and its image budget keeps stdout under the ~2 MB a
 * command may print.
 */
const PROBE_SOURCE = String.raw`import sys, json, io, re, time, base64
T0 = time.time()
A = sys.argv
OP, O, SRC = A[1], json.loads(A[2] or '{}'), A[3]


def emit(o):
    sys.stdout.buffer.write(json.dumps(o, ensure_ascii=False, separators=(',', ':')).encode('utf-8', 'replace'))
    sys.stdout.flush()


def font(size):
    from PIL import ImageFont
    try:
        return ImageFont.load_default(size=size)
    except Exception:
        return ImageFont.load_default()


def nice_step(span):
    for s in (0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001):
        if span / s >= 4:
            return s
    return 0.001


def label(v, step):
    d = len(('%g' % step).split('.')[1]) if step < 1 else 0
    t = '%.*f' % (d, v)
    return t[1:] if t.startswith('0.') and d > 1 else t


def rulers(im, hx, vy):
    # hx / vy: the page fractions at the left/right and top/bottom edges
    from PIL import Image, ImageDraw
    w, h = im.size
    L, M = 36, 20
    out = Image.new('RGB', (w + L + 8, h + M + 6), 'white')
    out.paste(im, (L, M))
    d = ImageDraw.Draw(out)
    f = font(12)
    for horiz, (a, b) in ((True, hx), (False, vy)):
        lo, hi = min(a, b), max(a, b)
        step = nice_step(hi - lo)
        k = int(lo / step - 1e-9) + 1 if lo > 0 else 0
        while k * step <= hi + 1e-9:
            v = k * step
            for sub, ln in ((v, 6), (v + step / 2, 3)):
                if sub > hi + 1e-9 or sub < lo - 1e-9:
                    continue
                r = (sub - a) / (b - a) if b != a else 0
                if horiz:
                    x = L + r * (w - 1)
                    d.line([(x, M - ln), (x, M - 1)], fill='black')
                else:
                    y = M + r * (h - 1)
                    d.line([(L - ln, y), (L - 1, y)], fill='black')
            t = label(v, step)
            tw = d.textlength(t, font=f)
            r = (v - a) / (b - a) if b != a else 0
            if horiz:
                x = min(max(L + r * (w - 1) - tw / 2, 0), L + w + 6 - tw)
                d.text((x, 1), t, fill='black', font=f)
            else:
                y = min(max(M + r * (h - 1) - 7, M - 6), M + h - 8)
                d.text((L - 8 - tw, y), t, fill='black', font=f)
            k += 1
    return out


def jbytes(t):
    return len(json.dumps(t, ensure_ascii=False).encode('utf-8', 'surrogatepass')) - 2


def jpeg(im, budget):
    # the image as base64 JPEG within budget characters, smaller or coarser if it must be; None if nothing fits
    from PIL import Image
    for side, q in ((0, 82), (0, 68), (0.8, 62), (0.65, 58), (0.5, 55)):
        img = im if not side else im.resize((max(1, int(im.width * side)), max(1, int(im.height * side))), Image.LANCZOS)
        b = io.BytesIO()
        img.save(b, 'JPEG', quality=q, optimize=True)
        s = base64.b64encode(b.getvalue()).decode('ascii')
        if len(s) <= budget:
            return {'data': s, 'w': img.width, 'h': img.height}
    return None


BAD = re.compile('[�-\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]')


def pdf_open():
    import pypdfium2 as pdfium
    try:
        return pdfium.PdfDocument(SRC)
    except pdfium.PdfiumError as e:
        m = str(e).lower()
        if 'password' in m or 'security' in m:
            raise RuntimeError('password-protected')
        raise


def pdf_stats(page, c, ct):
    W, H = page.get_size()
    area = max(W * H, 1.0)
    cnt = {'img': 0, 'path': 0, 'text': 0, 'inv': 0, 'ia': 0.0, 'seen': 0}
    L, B, R, T = ct.c_float(), ct.c_float(), ct.c_float(), ct.c_float()

    def walk(parent, form, depth):
        m = c.FPDFFormObj_CountObjects(parent) if form else c.FPDFPage_CountObjects(parent)
        for j in range(m):
            if cnt['seen'] > 60000:
                return
            cnt['seen'] += 1
            o = c.FPDFFormObj_GetObject(parent, j) if form else c.FPDFPage_GetObject(parent, j)
            t = c.FPDFPageObj_GetType(o)
            if t == c.FPDF_PAGEOBJ_PATH:
                cnt['path'] += 1
            elif t == c.FPDF_PAGEOBJ_TEXT:
                cnt['text'] += 1
                if c.FPDFTextObj_GetTextRenderMode(o) == c.FPDF_TEXTRENDERMODE_INVISIBLE:
                    cnt['inv'] += 1
            elif t == c.FPDF_PAGEOBJ_IMAGE:
                cnt['img'] += 1
                if c.FPDFPageObj_GetBounds(o, L, B, R, T):
                    cnt['ia'] += abs(R.value - L.value) * abs(T.value - B.value)
            elif t == c.FPDF_PAGEOBJ_FORM and depth < 6:
                walk(o, True, depth + 1)
    walk(page.raw, False, 0)
    tp = page.get_textpage()
    text = tp.get_text_range().replace('\r\n', '\n').replace('\r', '\n')
    n = tp.count_chars()
    err = 0
    for k in range(min(n, 20000)):
        if c.FPDFText_HasUnicodeMapError(tp.raw, k) == 1:
            err += 1
    core = re.sub(r'\s', '', text)
    bad = (len(BAD.findall(core)) + err) / max(len(core), 1)
    share = min(1.0, cnt['ia'] / area)
    return {
        'w': round(W, 1), 'h': round(H, 1), 'chars': len(core),
        'garbled': len(core) >= 20 and bad >= 0.08,
        'ocr': cnt['text'] > 0 and cnt['inv'] >= 0.8 * cnt['text'] and share >= 0.5,
        'images': cnt['img'], 'image_share': round(share, 3), 'paths': cnt['path'],
    }, text, tp


def ocr_text(page, tp, c, ct, box=None):
    # An OCR layer comes in the order its producer wrote its text objects, on many scans no order at all.
    # When the objects jump back up the page again and again, this is their text as lines sorted by place
    # (only lines in box, page fractions as displayed); None keeps pdfium's order.
    if not hasattr(c, 'FPDFText_GetTextObject'):
        return None
    W, H = page.get_size()
    D, DH = 10000, max(1, int(10000 * H / W))
    q = [ct.c_double() for _ in range(4)]
    dx, dy = ct.c_int(), ct.c_int()
    runs, obj = [], None
    for i in range(tp.count_chars()):
        o = ct.cast(c.FPDFText_GetTextObject(tp.raw, i), ct.c_void_p).value
        if o and o != obj:
            obj = o
            runs.append([i, 0, ''])
        if runs:
            u = c.FPDFText_GetUnicode(tp.raw, i)
            runs[-1][1] = i + 1 - runs[-1][0]
            runs[-1][2] += chr(u) if 31 < u < 0x110000 else ''
    L = []
    for i, n, s in runs:
        p = []
        for k in range(c.FPDFText_CountRects(tp.raw, i, n) if s.strip() else 0):
            if c.FPDFText_GetRect(tp.raw, k, *q):
                for a, b in ((0, 1), (2, 3)):
                    c.FPDF_PageToDevice(page.raw, 0, 0, D, DH, 0, q[a].value, q[b].value, dx, dy)
                    p.append((dx.value / D, dy.value / DH))
        if p:
            L.append((min(y for _, y in p), min(x for x, _ in p), max(x for x, _ in p), max(y for _, y in p), s.strip()))
    t = 0.006
    ups = sum(1 for a, b in zip(L, L[1:]) if b[0] < a[0] - t)
    flat = sum(len(r[4]) for r in L if (r[2] - r[1]) * W >= (r[3] - r[0]) * H)
    if ups < 3 or ups < 0.15 * (len(L) - 1) or flat < 0.8 * sum(len(r[4]) for r in L):
        return None
    out = []
    for r in sorted(L):
        # a line's top is where it starts; some OCR layers stretch the rest of its box downwards
        if box and not (box[0] <= (r[1] + r[2]) / 2 <= box[2] and box[1] - t <= r[0] <= box[3] - t):
            continue
        if out and r[0] - out[-1][0] <= t:
            out[-1][1].append(r[1:])
        else:
            out.append((r[0], [r[1:]]))
    return '\n'.join(' '.join(p[-1] for p in sorted(ln)) for _, ln in out)


def render_page(page, scale, crop=(0, 0, 0, 0)):
    return page.render(scale=scale, crop=crop, may_draw_forms=True).to_pil().convert('RGB')


def pdf_read():
    import pypdfium2.raw as c, ctypes as ct
    doc = pdf_open()
    n = len(doc)
    req = []
    for a, b in O.get('pages') or []:
        for p in range(a, min(n, b or n) + 1):
            if p not in req:
                req.append(p)
    explicit = bool(O.get('pages'))
    if explicit and not req:
        raise ValueError('pages names no page of this document, which has %d pages' % n)
    req = req or list(range(1, n + 1))
    # text budget in characters and in bytes of the JSON form history keeps (a quote or line break takes two), whichever runs out first
    budget, bbudget = O.get('text_chars', 100000), O.get('text_bytes', 200000)
    pages, used, bused, cut, cut_from, late = [], 0, 0, None, 0, None
    # text_from: where in the first page's text this read starts, so a page longer than the budget is read on from the place its last chunk ended
    start = max(0, int(O.get('text_from') or 0))
    for p in req:
        if time.time() - T0 > O.get('stats_seconds', 14):
            late = p
            break
        page = doc[p - 1]
        s, text, tp = pdf_stats(page, c, ct)
        if s['ocr']:
            text = ocr_text(page, tp, c, ct) or text
        tp.close()
        page.close()
        s['n'] = p
        if not pages and start:
            text = text[start:]
            s['text_from'] = start
        if cut is None:
            room = budget - used
            t = text[:room]
            if jbytes(t) > bbudget - bused:
                lo, hi = 0, len(t)
                while lo < hi:
                    mid = (lo + hi + 1) // 2
                    if jbytes(t[:mid]) <= bbudget - bused:
                        lo = mid
                    else:
                        hi = mid - 1
                t = t[:lo]
            if len(t) < len(text) and pages:
                cut = p
            else:
                s['text'] = t
                used += len(t)
                bused += jbytes(t)
                if len(t) < len(text):
                    s['text_cut'] = True
                    cut = p
                    cut_from = (start if s.get('text_from') else 0) + len(t)
        pages.append(s)
    sel = []
    if O.get('render'):
        if explicit:
            sel = pages[:O.get('max_render', 4)]
        elif n <= O.get('render_all_at_most', 3):
            # a short document: the pages that need a look (the same rule as pdfRead.ts), or all when no rule is given
            R = O.get('look')
            sel = [s for s in pages if not R or s['chars'] < R['littleText'] or s['garbled'] or s['image_share'] >= R['imageShare']
                   or s['paths'] >= R['drawingPaths'] or (s['chars'] < R['figureText'] and (s['images'] > 0 or s['paths'] >= R['figurePaths']))]
    left = O.get('image_chars', 1300000)
    for i, s in enumerate(sel):
        if time.time() - T0 > O.get('render_seconds', 22):
            s['skip'] = 'time'
            continue
        try:
            page = doc[s['n'] - 1]
            im = render_page(page, O.get('side', 1400) / max(s['w'], s['h'], 1))
            page.close()
            got = jpeg(rulers(im, (0, 1), (0, 1)), left // (len(sel) - i))
            if got:
                s['img'] = got
                left -= len(got['data'])
            else:
                s['skip'] = 'size'
        except Exception as e:
            s['skip'] = 'error: %s' % e
    emit({'ok': True, 'pages': n, 'unexamined_from': late, 'text_cut_at': cut, 'text_cut_from': cut_from, 'list': pages, 'seconds': round(time.time() - T0, 2)})


try:
    {'pdf-read': pdf_read}[OP]()
except Exception as e:
    emit({'ok': False, 'error': type(e).__name__, 'message': str(e)[:500]})
`;

/** The program as it is passed: without its comment lines and blank lines, which only the source needs. */
export const DOCUMENT_PROBE_SCRIPT = PROBE_SOURCE.replace(/^[ \t]*#.*\n/gm, '').replace(/\n{2,}/g, '\n');

/** A JPEG the probe returns, as base64. */
export interface ProbeImage {
  data: string;
  w: number;
  h: number;
}

/** What the probe found on one PDF page. */
export interface PdfPageFacts {
  n: number;
  /** Page size in points, as displayed (after the page's own rotation). */
  w: number;
  h: number;
  /** Non-whitespace characters in the text layer. */
  chars: number;
  /** Many replacement, private-use or control characters, or characters without a Unicode mapping. */
  garbled: boolean;
  /** The text is an invisible layer over a scanned image: OCR output. */
  ocr: boolean;
  images: number;
  /** Share of the page that image objects cover (0–1). */
  image_share: number;
  /** Vector path objects (lines, curves, shapes). */
  paths: number;
}

export interface PdfPageProbe extends PdfPageFacts {
  /** Absent once the text budget ran out. */
  text?: string;
  text_cut?: boolean;
  /** Where in the page's text this read starts (the page was read on from there). */
  text_from?: number;
  img?: ProbeImage;
  /** Why a page chosen for rendering came back without an image: `size`, `time`, `error: …`. */
  skip?: string;
}

export interface PdfReadProbe {
  ok: true;
  pages: number;
  /** The first requested page the time budget left unexamined. */
  unexamined_from: number | null;
  /** The page at which the text budget ran out (its text is cut or absent). */
  text_cut_at: number | null;
  /** Where in that page's text the unread part begins (0 when the page itself was left out whole). */
  text_cut_from: number;
  list: PdfPageProbe[];
  seconds: number;
}

export type ProbeOperation = 'pdf-read';

export type ProbeOutcome<T> =
  | { status: 'ok'; value: T }
  /** The program ran and reported a problem with the file (`error` is the Python exception name). */
  | { status: 'failed'; error: string; message: string }
  /** Python or its libraries could not be started. */
  | { status: 'unavailable'; detail: string }
  /** Python started but ended without an answer (crash, timeout, output cut off). */
  | { status: 'crashed'; detail: string }
  /** The file is larger than the host's file processor takes; nothing ran. */
  | { status: 'tooLarge'; bytes: number; limit: number }
  | { status: 'aborted' };

/**
 * The largest file the host's file processor copies for a program
 * (`electron/fileProcessorHost.cjs`); a larger one is refused before any
 * program starts.
 */
export const PROCESSOR_MAX_INPUT_BYTES = 64 * 1024 * 1024;

/**
 * Seconds the host gives the program before it is killed: the command
 * runner's timeout here, and the file processor's fixed 30 s. The program's
 * own time budgets (`stats_seconds`, `render_seconds`) stop it early enough to
 * answer, with what it did not get to, before this.
 */
export const PROBE_TIMEOUT_SECONDS = 30;

const COMMAND_PREFIX: Record<ProbeOperation, string> = {
  'pdf-read': 'read-pdf',
};

/** The interpreter used for the probe on this platform (the host resolves it to the bundled one). */
function probePython(): string {
  return isWindows() ? 'python' : 'python3';
}

/** The interpreter could not start, or one of its libraries is missing. */
function pythonUnavailable(output: CommandOutput): boolean {
  if (output.code === 127 || output.code === 9009) return true;
  return /ModuleNotFoundError|No module named|ImportError|command not found|is not recognized|ENOENT/i.test(String(output.stderr ?? ''));
}

/**
 * What went wrong, in words that hold no local path: an interpreter's or a
 * library's error names the folders it looked in, which hold the user's name.
 */
export function cleanProbeDetail(detail: string): string {
  const library = /No module named '?([\w.]+)'?/.exec(detail)?.[1];
  if (library) return `the Python library "${library.split('.')[0]}" is missing`;
  if (/python[\w.]*(?:\.exe)?['"]?:?\s*(?:command not found|No such file or directory)|is not recognized as an internal or external command|spawn\s+\S*python\S*\s+ENOENT/i.test(detail)) {
    return 'Python was not found';
  }
  return redactSensitiveMediaText(detail);
}

/**
 * Run one probe operation on a file. The path travels as the last argv
 * element and the options as JSON, never inside the program text.
 */
export async function runDocumentProbe<T>(
  filePath: string,
  operation: ProbeOperation,
  options: Record<string, unknown>,
  context?: ToolExecutionContext,
): Promise<ProbeOutcome<T>> {
  const python = probePython();
  const optionsJson = JSON.stringify(options);
  let output: CommandOutput;
  try {
    if (context?.files) {
      // The processor refuses a larger copy with an error that says nothing of the size.
      const bytes = (await context.files.stat(filePath)).size;
      if (bytes > PROCESSOR_MAX_INPUT_BYTES) return { status: 'tooLarge', bytes, limit: PROCESSOR_MAX_INPUT_BYTES };
    }
    output = context?.files
      ? await context.files.runProcessor(filePath, python, ['-c', DOCUMENT_PROBE_SCRIPT, operation, optionsJson, null])
      : await invokeTaskCommand<CommandOutput>('run_argv_command', {
        program: python,
        args: ['-c', DOCUMENT_PROBE_SCRIPT, operation, optionsJson, filePath],
        timeout: PROBE_TIMEOUT_SECONDS,
      }, context, { commandIdPrefix: COMMAND_PREFIX[operation] });
  } catch (err) {
    if (err instanceof FileOperationDenied) throw err;
    if (isTaskCommandAbortedError(err)) return { status: 'aborted' };
    return { status: 'unavailable', detail: cleanProbeDetail(err instanceof Error ? err.message : String(err)) };
  }
  if (context?.abortSignal?.aborted) return { status: 'aborted' };
  if (typeof output !== 'object' || output === null) return { status: 'crashed', detail: 'no output' };
  if (output.code !== 0) {
    const detail = cleanProbeDetail(String(output.stderr ?? '').trim().split('\n').slice(-3).join('\n').slice(0, 500) || `exit code ${output.code}`);
    return pythonUnavailable(output) ? { status: 'unavailable', detail } : { status: 'crashed', detail };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(output.stdout));
  } catch {
    return { status: 'crashed', detail: String(output.stdout).endsWith('[truncated: output too large]') ? 'output too large' : 'unreadable output' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { status: 'crashed', detail: 'unreadable output' };
  const record = parsed as Record<string, unknown>;
  if (record.ok === true) return { status: 'ok', value: parsed as T };
  const error = typeof record.error === 'string' ? record.error : 'Error';
  const message = typeof record.message === 'string' ? cleanProbeDetail(record.message) : '';
  // The program reports its own import failures: a library is missing.
  if (error === 'ModuleNotFoundError' || error === 'ImportError') return { status: 'unavailable', detail: message };
  return { status: 'failed', error, message };
}

/** "67.4 MB" */
function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} MB`;
}

/** The error read_file gives for a file over the processor's limit. */
export function tooLargeError(fileName: string, bytes: number, limit: number): string {
  return format(getI18n().toolResult.fileRead.tooLarge, { name: fileName, size: megabytes(bytes), limit: megabytes(limit) });
}
