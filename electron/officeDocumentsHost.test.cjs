'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

// The Host talks to the native helper; the helper is a real Windows process
// with real Office attached to it, so the seam under test is the filtering and
// disclosure logic on this side of that call.
const managerPath = require.resolve('./nativeHelperManager.cjs');
const NATIVE_HELPER_MISS = Symbol('native-helper-miss');
let helperReport = { documents: [], complete: true };
let lastHelperCall = null;

require.cache[managerPath] = {
  id: managerPath,
  filename: managerPath,
  loaded: true,
  exports: {
    NATIVE_HELPER_MISS,
    nativeHelperDispatch: async (cmd, args) => {
      lastHelperCall = { cmd, args };
      return helperReport;
    },
  },
};

const {
  officeDocumentsDispatch,
  OFFICE_DOCUMENTS_MISS,
  fileNameOf,
  samePath,
} = require('./officeDocumentsHost.cjs');

const onWindows = process.platform === 'win32';
const skipOffWindows = onWindows ? false : 'Windows-only host command';

function document(overrides) {
  return { app: 'Excel', name: 'book.xlsx', path: 'F:\\work\\book.xlsx', unsaved: false, ...overrides };
}

test('leaves commands it does not own alone', async () => {
  assert.equal(await officeDocumentsDispatch('read_file', {}), OFFICE_DOCUMENTS_MISS);
});

test('refuses to answer without a path', async () => {
  await assert.rejects(() => officeDocumentsDispatch('office_open_documents', {}), /requires a file path/);
  await assert.rejects(
    () => officeDocumentsDispatch('office_open_documents', { path: '   ' }),
    /requires a file path/,
  );
});

// The whole point of taking a path rather than returning the list: the helper
// can see every document the user has open, and a model that asked about one
// spreadsheet has no business learning about the others.
test(
  'discloses only documents sharing the name that was asked about',
  { skip: skipOffWindows },
  async () => {
    helperReport = {
      complete: true,
      documents: [
        document(),
        document({ app: 'Word', name: '离职协议.docx', path: 'C:\\private\\离职协议.docx' }),
        document({ app: 'WPS Spreadsheets', name: '工资表.xlsx', path: 'C:\\private\\工资表.xlsx' }),
      ],
    };

    const result = await officeDocumentsDispatch('office_open_documents', { path: 'F:\\work\\book.xlsx' });

    assert.equal(result.documents.length, 1);
    assert.equal(result.documents[0].name, 'book.xlsx');
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('离职协议'), 'unrelated documents must not leak');
    assert.ok(!serialized.includes('工资表'), 'unrelated documents must not leak');
  },
);

test('reports a same-named document from another folder as a different file', { skip: skipOffWindows }, async () => {
  helperReport = { complete: true, documents: [document({ path: 'D:\\archive\\book.xlsx' })] };

  const result = await officeDocumentsDispatch('office_open_documents', { path: 'F:\\work\\book.xlsx' });

  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].samePath, false);
});

test('matches the same file written with either separator or case', { skip: skipOffWindows }, async () => {
  helperReport = { complete: true, documents: [document({ path: 'F:\\Work\\Book.xlsx' })] };

  const result = await officeDocumentsDispatch('office_open_documents', { path: 'F:/work/book.xlsx' });

  assert.equal(result.documents[0].samePath, true);
});

// "Could not tell" and "nothing is open" send the user to opposite places, so
// the flag has to survive the trip rather than being flattened into an empty
// list.
test('keeps "could not determine" distinct from "nothing open"', { skip: skipOffWindows }, async () => {
  helperReport = { complete: false, documents: [] };

  const result = await officeDocumentsDispatch('office_open_documents', { path: 'F:\\work\\book.xlsx' });

  assert.equal(result.complete, false);
  assert.deepEqual(result.documents, []);
});

test('an unsaved flag is only ever true when the helper said so', { skip: skipOffWindows }, async () => {
  helperReport = {
    complete: true,
    documents: [document({ unsaved: 'yes' })],
  };

  const result = await officeDocumentsDispatch('office_open_documents', { path: 'F:\\work\\book.xlsx' });

  assert.equal(result.documents[0].unsaved, false, 'a non-boolean must not read as unsaved');
});

test('asks the helper for nothing but the enumeration', { skip: skipOffWindows }, async () => {
  helperReport = { complete: true, documents: [] };
  await officeDocumentsDispatch('office_open_documents', { path: 'F:\\work\\book.xlsx' });
  assert.equal(lastHelperCall.cmd, 'office_documents');
  // The path stays on this side. Sending it would put a user file path into
  // the helper's argument log for no gain — the filtering happens here.
  assert.deepEqual(lastHelperCall.args, {});
});

test('answers on platforms with no attach surface instead of failing', { skip: onWindows ? 'Windows' : false }, async () => {
  const result = await officeDocumentsDispatch('office_open_documents', { path: '/Users/x/book.xlsx' });
  assert.deepEqual(result, { supported: false, complete: false, documents: [] });
});

test('file names come off either separator', () => {
  assert.equal(fileNameOf('F:\\work\\Book.xlsx'), 'book.xlsx');
  assert.equal(fileNameOf('/home/x/Book.xlsx'), 'book.xlsx');
  assert.equal(fileNameOf('book.xlsx'), 'book.xlsx');
  assert.equal(samePath('F:\\a\\b.xlsx', 'f:/A/B.xlsx'), true);
  assert.equal(samePath('F:\\a\\b.xlsx', 'F:\\a\\c.xlsx'), false);
});

test('module lives where the host router expects it', () => {
  assert.equal(path.basename(require.resolve('./officeDocumentsHost.cjs')), 'officeDocumentsHost.cjs');
});
