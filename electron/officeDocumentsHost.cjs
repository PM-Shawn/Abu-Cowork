'use strict';

/**
 * Is this file open in Office or WPS right now?
 *
 * The assistant needs this before it writes a document the user may be sitting
 * in: writing behind the application's back either fails outright or discards
 * their unsaved edits. Finding out from a `PermissionError` halfway through is
 * too late to ask them what they want.
 *
 * ## Why this is not a Computer Use command
 *
 * Two reasons, and both matter.
 *
 * 1. The document skills (`docx`/`xlsx`/`pptx`/`pdf`) block the `computer`
 *    tool — deliberately, because documents must not be edited by clicking a
 *    GUI. Putting this behind that same tool would make it unreachable in the
 *    one place it exists to serve.
 * 2. It reads nothing from the screen, synthesizes no input, and cannot start
 *    an application. A user who turned Computer Use off still deserves to be
 *    told their spreadsheet is open rather than watching a write fail.
 *
 * ## What is disclosed
 *
 * Only documents whose file name matches the one that was asked about. The
 * helper can enumerate everything the user has open; handing that list to a
 * model because it was about to write one file would be a disclosure nobody
 * asked for. The full path of a *matching* document is returned, because
 * "open, but from a different folder" is the answer in that case.
 */

const { nativeHelperDispatch, NATIVE_HELPER_MISS } = require('./nativeHelperManager.cjs');

const OFFICE_DOCUMENTS_MISS = Symbol('office-documents-miss');

/** Last path segment, for either separator, lowercased. */
function fileNameOf(value) {
  const normalized = String(value).replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return (lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1)).trim().toLowerCase();
}

function samePath(a, b) {
  return String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
}

async function officeDocumentsDispatch(cmd, args) {
  if (cmd !== 'office_open_documents') return OFFICE_DOCUMENTS_MISS;

  const requestedPath = typeof args?.path === 'string' ? args.path.trim() : '';
  if (!requestedPath) {
    throw new Error('office_open_documents requires a file path');
  }

  if (process.platform !== 'win32') {
    // Not a failure: macOS has no equivalent attach surface wired up, and the
    // caller's next move (write the file) is the same as when nothing is open.
    return { supported: false, complete: false, documents: [] };
  }

  const report = await nativeHelperDispatch('office_documents', {});
  if (report === NATIVE_HELPER_MISS) {
    throw new Error('native helper does not own office_documents');
  }

  const wanted = fileNameOf(requestedPath);
  const documents = (report?.documents ?? [])
    .filter((document) => fileNameOf(document?.path || document?.name || '') === wanted)
    .map((document) => ({
      app: document.app,
      name: document.name,
      path: document.path,
      unsaved: document.unsaved === true,
      // The application may have the file open from a different folder — same
      // name, different file. Saying which is the difference between a useful
      // warning and a false alarm.
      samePath: Boolean(document.path) && samePath(document.path, requestedPath),
    }));

  return {
    supported: true,
    // False when the COM thread did not answer — an Office instance parked on
    // a modal dialog does not respond to automation at all. "Could not tell"
    // must not be reported as "nothing is open".
    complete: report?.complete === true,
    documents,
  };
}

module.exports = { officeDocumentsDispatch, OFFICE_DOCUMENTS_MISS, fileNameOf, samePath };
