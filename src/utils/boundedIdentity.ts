/**
 * Encode an untrusted identity component into bounded ASCII.
 *
 * `encodeURIComponent` is not total for lone UTF-16 surrogates. Repair those
 * inputs before encoding and attach a stable digest of the original code
 * units. Long values use the same digest after truncation. The raw `|x|`
 * marker cannot occur in a normal `encodeURIComponent` result (`|` becomes
 * `%7C`), so transformed and ordinary inputs occupy disjoint domains.
 */

function stableIdentityHash(value: string): string {
  const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const primes = [0x01000193, 0x27d4eb2d, 0x165667b1, 0x1b873593];
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    for (let hashIndex = 0; hashIndex < hashes.length; hashIndex++) {
      hashes[hashIndex] = Math.imul(hashes[hashIndex] ^ codeUnit, primes[hashIndex]);
    }
  }
  return hashes.map((hash) => (hash >>> 0).toString(16).padStart(8, '0')).join('');
}
function replaceLoneSurrogates(value: string): string {
  let repaired = '';
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        repaired += value[index] + value[index + 1];
        index++;
      } else {
        repaired += '\ufffd';
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      repaired += '\ufffd';
    } else {
      repaired += value[index];
    }
  }
  return repaired;
}

function trimIncompletePercentEscape(value: string): string {
  if (value.endsWith('%')) return value.slice(0, -1);
  if (/%[0-9A-F]$/.test(value)) return value.slice(0, -2);
  return value;
}

export function encodeBoundedIdentityPart(value: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  const repaired = replaceLoneSurrogates(value);
  const encoded = encodeURIComponent(repaired);
  if (repaired === value && encoded.length <= limit) return encoded;

  // Every character in the encoded form and suffix is ASCII, so code-unit
  // length equals JSON-independent UTF-8 byte length.
  const suffix = `|x|${value.length.toString(36)}-${stableIdentityHash(value)}`;
  if (suffix.length >= limit) return suffix.slice(0, limit);
  const prefixBytes = limit - suffix.length;
  return `${trimIncompletePercentEscape(encoded.slice(0, prefixBytes))}${suffix}`;
}
