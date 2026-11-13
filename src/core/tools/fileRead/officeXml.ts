import { Parser } from 'htmlparser2';

/**
 * The one place that reads the XML of a Word, Excel or PowerPoint package.
 *
 * XML says the same thing many ways: attribute values in double or single
 * quotes, spaces around `=`, text as character data or as a CDATA section,
 * an empty element as `<a/>` or `<a></a>`, any prefix (or the default
 * namespace) for a namespace. Producers differ in all of these, and a pattern
 * written against one writer's output reads another's as empty. So nothing
 * outside this file matches XML text: the parser reads it, namespaces are
 * resolved, and the callers get names and attribute values.
 */

/**
 * The prefix callers use for each namespace. Producers choose their own
 * prefixes: Excel writes `<xdr:oneCellAnchor>` and `<c:barChart>`, openpyxl
 * writes the same elements in a default namespace (`<oneCellAnchor>`,
 * `<barChart>`), the .NET Open XML SDK writes `<x:sheet>`. A name from one of
 * these namespaces comes out with the prefix below, whatever prefix (or
 * default namespace) the part declares; any other name comes out as written.
 */
const CANONICAL_PREFIX: Record<string, string> = {
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://schemas.openxmlformats.org/presentationml/2006/main': 'p',
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main': '',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing': 'xdr',
  'http://schemas.openxmlformats.org/drawingml/2006/chart': 'c',
  'http://schemas.microsoft.com/office/drawing/2014/chartex': 'cx',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://schemas.openxmlformats.org/package/2006/relationships': '',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'urn:schemas-microsoft-com:vml': 'v',
  'http://schemas.microsoft.com/office/drawing/2016/SVG/main': 'asvg',
  // "Strict Open XML", which Excel, Word and PowerPoint can save
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://purl.oclc.org/ooxml/presentationml/main': 'p',
  'http://purl.oclc.org/ooxml/spreadsheetml/main': '',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing': 'xdr',
  'http://purl.oclc.org/ooxml/drawingml/chart': 'c',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
};

export interface XmlHandler {
  /** An element opens. `attributes` are decoded, under their canonical names; namespace declarations are left out. */
  open?(name: string, attributes: Readonly<Record<string, string>>): void;
  /** Character data, entities decoded, CDATA included. It may arrive in several pieces. */
  text?(text: string): void;
  close?(name: string): void;
}

type Scope = Map<string, string>;

/** A name from a known namespace under its canonical prefix; any other name as written. */
function canonicalName(scope: Scope, qualified: string, isAttribute: boolean): string {
  const colon = qualified.indexOf(':');
  const prefix = colon < 0 ? '' : qualified.slice(0, colon);
  const local = colon < 0 ? qualified : qualified.slice(colon + 1);
  // An unprefixed attribute is in no namespace, whatever the default is.
  if (prefix === 'xml' || (isAttribute && !prefix)) return qualified;
  const namespace = scope.get(prefix);
  const canonical = namespace === undefined ? undefined : CANONICAL_PREFIX[namespace];
  if (canonical === undefined) return qualified;
  return canonical ? `${canonical}:${local}` : local;
}

/** Read `text` as XML and tell `handler` what it holds, in document order. Malformed markup is read as far as it goes. */
export function parseXml(text: string, handler: XmlHandler): void {
  let scope: Scope = new Map();
  // Per open element: the scope outside it and its canonical name.
  const open: Array<{ outer: Scope; name: string }> = [];
  const parser = new Parser({
    onopentag(qualified, raw) {
      const outer = scope;
      for (const key of Object.keys(raw)) {
        if (key !== 'xmlns' && !key.startsWith('xmlns:')) continue;
        if (scope === outer) scope = new Map(outer);
        scope.set(key === 'xmlns' ? '' : key.slice(6), raw[key]);
      }
      const name = canonicalName(scope, qualified, false);
      open.push({ outer, name });
      const attributes: Record<string, string> = {};
      for (const key of Object.keys(raw)) {
        if (key !== 'xmlns' && !key.startsWith('xmlns:')) attributes[canonicalName(scope, key, true)] = raw[key];
      }
      handler.open?.(name, attributes);
    },
    ontext(data) {
      handler.text?.(data);
    },
    onclosetag() {
      const element = open.pop();
      if (!element) return;
      scope = element.outer;
      handler.close?.(element.name);
    },
  }, { xmlMode: true });
  parser.write(text);
  parser.end();
}

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, '&quot;');

/**
 * The XML of a part written one plain way: canonical prefixes, double-quoted
 * attributes, text as escaped character data, empty elements as `<a/>`,
 * no comments, processing instructions or namespace declarations. For readers
 * that look for text in it; it carries what `parseXml` reads and nothing else.
 */
export function normalizeXml(text: string): string {
  let out = '';
  let unclosed = false;
  parseXml(text, {
    open(name, attributes) {
      if (unclosed) out += '>';
      out += `<${name}`;
      for (const [key, value] of Object.entries(attributes)) out += ` ${key}="${escapeAttribute(value)}"`;
      unclosed = true;
    },
    text(data) {
      if (unclosed) out += '>';
      unclosed = false;
      out += escapeText(data);
    },
    close(name) {
      out += unclosed ? '/>' : `</${name}>`;
      unclosed = false;
    },
  });
  return out;
}
