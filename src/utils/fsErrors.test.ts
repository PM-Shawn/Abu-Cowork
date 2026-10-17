import { describe, expect, it } from 'vitest';
import { isMissingPathError } from './fsErrors';

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('isMissingPathError', () => {
  it('reads the code of a Node error', () => {
    expect(isMissingPathError(withCode('ENOENT: no such file or directory', 'ENOENT'))).toBe(true);
    expect(isMissingPathError(withCode('ENOTDIR: not a directory', 'ENOTDIR'))).toBe(true);
  });

  it('reads the message of an error that lost its code crossing IPC', () => {
    expect(isMissingPathError(new Error("Error invoking remote method 'tauri:invoke': Error: ENOENT: no such file or directory, stat '/a/b.md'"))).toBe(true);
    expect(isMissingPathError(new Error("Error invoking remote method 'tauri:invoke': Error: ENOTDIR: not a directory, stat '/a/file/b.md'"))).toBe(true);
    expect(isMissingPathError(new Error("Error invoking remote method 'tauri:invoke': no such file or directory"))).toBe(true);
    expect(isMissingPathError('The system cannot find the path specified.')).toBe(true);
    expect(isMissingPathError('No such file or directory (os error 2)')).toBe(true);
  });

  it('does not take any other failure for a missing path', () => {
    expect(isMissingPathError(withCode('EACCES: permission denied', 'EACCES'))).toBe(false);
    expect(isMissingPathError(withCode('EPERM: operation not permitted', 'EPERM'))).toBe(false);
    expect(isMissingPathError(withCode('EIO: i/o error', 'EIO'))).toBe(false);
    expect(isMissingPathError(new Error("Error invoking remote method 'tauri:invoke': Error: EACCES: permission denied, stat '/a/b.md'"))).toBe(false);
    expect(isMissingPathError(null)).toBe(false);
  });

  it('reads no words of the path in the message', () => {
    const inFolder = '/Users/a/404 Not Found 排查/cannot find the file specified/no such file or directory/a.mov';
    expect(isMissingPathError(withCode(`EACCES: permission denied, stat '${inFolder}'`, 'EACCES'))).toBe(false);
    expect(isMissingPathError(new Error(`Error invoking remote method 'tauri:invoke': Error: EACCES: permission denied, stat '${inFolder}'`))).toBe(false);
    expect(isMissingPathError(withCode(`ENOENT: no such file or directory, stat '${inFolder}'`, 'ENOENT'))).toBe(true);
  });
});
