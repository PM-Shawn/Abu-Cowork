import type { ToolExecutionContext } from '@/types';
import type { FitStep } from '@/core/llm/imageFit';
import { base64ToUint8Array } from '@/utils/base64';
import { invokeTaskCommand, isTaskCommandAbortedError } from './scopedCommand';
import type { CommandOutput } from './toolHelpers';
import { isWindows } from '@/utils/platform';

/**
 * The encoder of the one picture-fitting rule (`planImageFit`) for a read_file
 * call that has no native file access: the open-source Electron build, where no
 * authorization provider hands the tool a `files` object. It runs one step of
 * the plan on the bundled Python (Pillow), the same interpreter read_file's PDF
 * and picture views use, so macOS and Windows give the same pixels.
 *
 * The program holds no policy: it resizes to the given width, writes a JPEG or a
 * PNG, and says whether the result is within the given byte limit. The caller
 * walks the steps. The fitted picture comes back as base64 on stdout, which a
 * command may fill to about 2 MB, so the limit passed in is also capped by what
 * fits there (`PYTHON_FIT_MAX_BYTES`): a step whose output is over that counts as
 * over the limit and the next, smaller step is tried.
 *
 * The program is passed with `python -c`; the path is its argv, never part of
 * its text. It holds no backtick and no `${` (it lives in a raw template literal).
 */
const FIT_SOURCE = String.raw`import sys, json, io, base64
from PIL import Image
path, width, fmt, quality, limit = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4]), int(sys.argv[5])


def emit(o):
    sys.stdout.write(json.dumps(o, separators=(',', ':')))
    sys.stdout.flush()


try:
    im = Image.open(path)
    if im.format not in ('PNG', 'JPEG', 'GIF', 'BMP', 'TIFF', 'WEBP'):
        raise ValueError('not a raster picture')
    source = im.format
    im.load()
    if width < im.width:
        im = im.resize((width, max(1, round(im.height * width / im.width))), Image.LANCZOS)
    jpeg = fmt == 'jpeg' or (fmt == 'same' and source == 'JPEG')
    if jpeg and (im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info)):
        im = im.convert('RGBA')
        flat = Image.new('RGB', im.size, 'white')
        flat.paste(im, mask=im.getchannel('A'))
        im = flat
    if jpeg:
        im = im.convert('RGB')
    elif im.mode not in ('RGB', 'RGBA', 'L', 'LA', 'P'):
        im = im.convert('RGBA')
    out = io.BytesIO()
    if jpeg:
        im.save(out, 'JPEG', quality=quality, optimize=True)
    else:
        im.save(out, 'PNG', optimize=True)
    raw = out.getvalue()
    if len(raw) > limit:
        emit({'ok': True, 'over': len(raw)})
    else:
        emit({'ok': True, 'data': base64.b64encode(raw).decode('ascii')})
except Exception as e:
    emit({'ok': False, 'error': type(e).__name__})
`;

/** About 1.4 MB: its base64 form, with the JSON around it, stays under the ~2 MB a command may print. */
export const PYTHON_FIT_MAX_BYTES = 1_400_000;

export type PythonFitResult =
  | { status: 'ok'; bytes: Uint8Array }
  /** The picture came out over the byte limit. */
  | { status: 'over' }
  /** Python could not run, a library is missing, or the file is no picture it opens. */
  | { status: 'failed' };

/**
 * One step of the fit plan on a picture file. A command that was aborted throws
 * (`isTaskCommandAbortedError`), exactly as the native encoder does.
 */
export async function fitPictureWithPython(
  path: string,
  step: FitStep,
  maxBytes: number,
  context?: ToolExecutionContext,
): Promise<PythonFitResult> {
  let output: CommandOutput;
  try {
    output = await invokeTaskCommand<CommandOutput>('run_argv_command', {
      program: isWindows() ? 'python' : 'python3',
      args: ['-c', FIT_SOURCE, path, String(step.width), step.format, String(step.quality), String(Math.min(maxBytes, PYTHON_FIT_MAX_BYTES))],
      timeout: 30,
    }, context, { commandIdPrefix: 'fit-image' });
  } catch (err) {
    if (isTaskCommandAbortedError(err)) throw err;
    return { status: 'failed' };
  }
  if (typeof output !== 'object' || output === null || output.code !== 0) return { status: 'failed' };
  try {
    const parsed = JSON.parse(String(output.stdout)) as { ok?: boolean; data?: string; over?: number };
    if (parsed.ok !== true) return { status: 'failed' };
    if (typeof parsed.data === 'string') return { status: 'ok', bytes: base64ToUint8Array(parsed.data) };
    if (typeof parsed.over === 'number') return { status: 'over' };
  } catch {
    /* unreadable output: as failed */
  }
  return { status: 'failed' };
}
