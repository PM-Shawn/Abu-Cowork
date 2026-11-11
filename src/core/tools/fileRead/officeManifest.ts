/**
 * What a .docx, .xlsx or .pptx holds besides its text: the pictures it embeds
 * (numbered, with where each sits), the charts it defines, and embedded
 * objects. Read straight from the zip parts in JavaScript, so listing them
 * needs no Python; Python only renders a picture when one must be shown.
 *
 * Picture numbers (`image_index`) follow the reading order: the body text of a
 * Word document, the sheets of a workbook, the slides of a presentation, then
 * pictures used elsewhere (headers, slide layouts) or nowhere. The same file
 * always gets the same numbers, so a later read_file with `image_index` finds
 * the picture this listing named.
 */

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

export interface OfficePicture {
  /** The `image_index` read_file takes. */
  index: number;
  /** Zip part, e.g. `word/media/image3.png`. */
  part: string;
  format: string;
  bytes: number;
  width?: number;
  height?: number;
  /** Where the picture is used: "slide 3", "sheet 'Key Stats' at B4", "header". */
  where: string[];
  /** Pillow can draw it; EMF, WMF and SVG pictures, videos and sounds cannot be shown. */
  renderable: boolean;
  /** A video or sound the file embeds among its media: listed, never shown. */
  media?: 'video' | 'audio';
  /** Placed in the body (the text, a slide, a sheet) rather than only in a header, layout or master, or nowhere. */
  inBody: boolean;
}

export interface ChartSeries {
  name?: string;
  /** The values the chart caches for its categories and values, when there are few of them. */
  cachedCategories?: string[];
  cachedValues?: string[];
  categories?: string;
  values?: string;
  x?: string;
  y?: string;
  sizes?: string;
  /** chartex (newer chart types) data formula */
  data?: string;
}

export interface OfficeChart {
  index: number;
  type: string;
  title: string;
  series: ChartSeries[];
  where: string;
}

export interface OfficeManifest {
  kind: OfficeKind;
  pictures: OfficePicture[];
  charts: OfficeChart[];
  /** Embedded OLE objects and packages (another workbook inside a document, …), by file name. */
  embeddedObjects: string[];
  /** docx: the body text with `[Image N]` and `[Chart N]` where each sits. */
  text?: string;
  /** pptx: per slide, its text lines and the pictures and charts on it. */
  slides?: Array<{ lines: string[]; pictures: number[]; charts: number[] }>;
  /** xlsx: the sheets in workbook order. */
  sheets?: Array<{ name: string; hidden: boolean; chartsheet: boolean }>;
}

export type ZipEntries = Record<string, Uint8Array>;

const RENDERABLE = new Set(['png', 'jpg', 'jpeg', 'jpe', 'gif', 'bmp', 'tif', 'tiff', 'webp']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'avi', 'wmv', 'mpg', 'mpeg', 'mkv', 'webm', 'asf', 'flv', '3gp']);
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'wma', 'aac', 'ogg', 'oga', 'mid', 'midi', 'aif', 'aiff', 'flac']);
/** Relationship types by which a slide or document links a video or sound. */
const MEDIA_RELATIONSHIPS = new Set(['video', 'audio', 'media']);
const MAX_CHARTS = 40;
const MAX_SERIES = 30;
/** Cached chart points listed per series; longer series are named by their cells only. */
const MAX_CACHED_POINTS = 24;

const decoder = new TextDecoder();

/**
 * The prefix this module's patterns use for each namespace. Producers choose
 * their own prefixes: Excel writes `<xdr:oneCellAnchor>` and `<c:barChart>`,
 * openpyxl writes the same elements in a default namespace (`<oneCellAnchor>`,
 * `<barChart>`), the .NET Open XML SDK writes `<x:sheet>`. Reading by
 * namespace means renaming each part's prefixes to these before matching.
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

const NAMESPACE_DECLARATION = /\sxmlns(?::([\w.-]+))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** A comment, CDATA section, processing instruction or doctype, left as it is; or a tag, with its attributes. */
const XML_MARKUP = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!(?!--|\[CDATA\[)[^>]*>|<(\/?)([\w.-]+(?::[\w.-]+)?)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTRIBUTE = /(\s)([\w.:-]+)(\s*=\s*(?:"[^"]*"|'[^']*'))/g;

/**
 * A part's XML with every element and attribute of the namespaces above
 * written with their prefix, whatever prefix (or default namespace) the part
 * declares, element by element as XML scopes them. A part that already uses
 * these prefixes is returned as it is.
 */
export function canonicalPrefixes(text: string): string {
  const declarations = [...text.matchAll(NAMESPACE_DECLARATION)];
  if (declarations.every((match) => {
    const canonical = CANONICAL_PREFIX[match[2] ?? match[3]];
    return canonical === undefined || canonical === (match[1] ?? '');
  })) return text;

  // Each open element's prefix → namespace map; the root has none declared.
  const scopes: Array<Map<string, string>> = [new Map()];
  const renamed = (scope: Map<string, string>, qualified: string, isAttribute: boolean): string => {
    const colon = qualified.indexOf(':');
    const prefix = colon < 0 ? '' : qualified.slice(0, colon);
    const local = colon < 0 ? qualified : qualified.slice(colon + 1);
    // An unprefixed attribute is in no namespace, whatever the default is.
    if (prefix === 'xmlns' || prefix === 'xml' || (isAttribute && !prefix)) return qualified;
    const namespace = scope.get(prefix);
    const canonical = namespace === undefined ? undefined : CANONICAL_PREFIX[namespace];
    if (canonical === undefined) return qualified;
    return canonical ? `${canonical}:${local}` : local;
  };
  return text.replace(XML_MARKUP, (whole, slash: string | undefined, name: string | undefined, attributesText: string, selfClosing: string) => {
    if (name === undefined) return whole;
    if (slash) {
      const scope = scopes[scopes.length - 1];
      if (scopes.length > 1) scopes.pop();
      return `</${renamed(scope, name, false)}${attributesText}>`;
    }
    let scope = scopes[scopes.length - 1];
    const declared = [...attributesText.matchAll(NAMESPACE_DECLARATION)];
    if (declared.length) {
      scope = new Map(scope);
      for (const match of declared) scope.set(match[1] ?? '', match[2] ?? match[3]);
    }
    if (!selfClosing) scopes.push(scope);
    const attributes = attributesText.replace(ATTRIBUTE, (_all, space: string, attribute: string, value: string) => (
      `${space}${renamed(scope, attribute, true)}${value}`
    ));
    return `<${renamed(scope, name, false)}${attributes}${selfClosing}>`;
  });
}

function xml(entries: ZipEntries, part: string): string {
  const bytes = entries[part];
  return bytes ? canonicalPrefixes(decoder.decode(bytes)) : '';
}

/** XML character entities. */
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return '\'';
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[match[1]] = match[2];
  return out;
}

/** Resolve a relationship target against the directory of the part that names it. */
function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment && segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

interface Relationship { part: string; type: string }

function relationships(entries: ZipEntries, part: string): Map<string, Relationship> {
  const slash = part.lastIndexOf('/');
  const relsPart = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
  const out = new Map<string, Relationship>();
  for (const match of xml(entries, relsPart).matchAll(/<Relationship\b([^>]*)>/g)) {
    const attrs = attributes(match[1]);
    if (!attrs.Id || attrs.TargetMode === 'External' || !attrs.Target) continue;
    out.set(attrs.Id, { part: resolvePart(part, decodeXml(attrs.Target)), type: (attrs.Type ?? '').split('/').pop() ?? '' });
  }
  return out;
}

/** Office stores an alternate rendering in `mc:Fallback`; reading both would count everything twice. */
function withoutFallbacks(text: string): string {
  return text.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '');
}

function u16be(b: Uint8Array, i: number): number { return (b[i] << 8) | b[i + 1]; }
function u16le(b: Uint8Array, i: number): number { return b[i] | (b[i + 1] << 8); }
function u32be(b: Uint8Array, i: number): number { return ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; }
function i32le(b: Uint8Array, i: number): number { return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24); }

/** Pixel size from a PNG, JPEG, GIF, BMP or WebP header; null for other formats. */
export function pictureSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16le(b, 6), height: u16le(b, 8) };
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) return { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
      i += 2 + u16be(b, i + 2);
    }
    return null;
  }
  if (b.length >= 30 && decoder.decode(b.subarray(0, 4)) === 'RIFF' && decoder.decode(b.subarray(8, 12)) === 'WEBP') {
    const chunk = decoder.decode(b.subarray(12, 16));
    if (chunk === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/** "AB" for column 27 (0-based). */
function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function plainText(fragment: string): string {
  return decodeXml([...fragment.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(''));
}

/** Type, title and the cell ranges of each series, from a chart part's definition. */
export function readChart(entries: ZipEntries, part: string): Omit<OfficeChart, 'index' | 'where'> {
  const text = xml(entries, part);
  const kinds = [...new Set([...text.matchAll(/<(?:c|cx):(\w+Chart)\b/g)].map((m) => m[1]))];
  if (!kinds.length) kinds.push(...new Set([...text.matchAll(/layoutId="(\w+)"/g)].map((m) => m[1])));
  const direction = /<c:barDir val="(\w+)"/.exec(text)?.[1];
  const grouping = /<c:grouping val="(\w+)"/.exec(text)?.[1];
  const head = text.split(/<(?:c|cx):plotArea>/)[0];
  const titleXml = /<(?:c|cx):title>([\s\S]*?)<\/(?:c|cx):title>/.exec(head)?.[1] ?? '';
  const titleFormula = /<c:f>([^<]*)<\/c:f>/.exec(titleXml)?.[1];
  const title = plainText(titleXml) || (titleFormula ? `=${decodeXml(titleFormula)}` : '');
  const series: ChartSeries[] = [];
  for (const match of [...text.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].slice(0, MAX_SERIES)) {
    const entry: ChartSeries = {};
    const fields: Array<['name' | 'categories' | 'values' | 'x' | 'y' | 'sizes', string]> = [['name', 'tx'], ['categories', 'cat'], ['values', 'val'], ['x', 'xVal'], ['y', 'yVal'], ['sizes', 'bubbleSize']];
    for (const [key, tag] of fields) {
      const body = new RegExp(`<c:${tag}>([\\s\\S]*?)</c:${tag}>`).exec(match[1])?.[1];
      if (!body) continue;
      const formula = /<c:f>([^<]*)<\/c:f>/.exec(body)?.[1];
      const literal = /<c:v>([^<]*)<\/c:v>/.exec(body)?.[1];
      if (key === 'name') {
        const name = literal ?? (formula ? `=${formula}` : undefined);
        if (name !== undefined) entry.name = decodeXml(name);
        continue;
      }
      if (formula) entry[key] = decodeXml(formula);
      const points = [...body.matchAll(/<c:pt\b[^>]*>\s*<c:v>([^<]*)<\/c:v>/g)].map((m) => decodeXml(m[1]));
      if (points.length && points.length <= MAX_CACHED_POINTS) {
        if (key === 'categories' || key === 'x') entry.cachedCategories = points;
        if (key === 'values' || key === 'y') entry.cachedValues = points;
      }
    }
    series.push(entry);
  }
  if (!series.length) {
    for (const match of [...text.matchAll(/<cx:f[^>]*>([^<]*)<\/cx:f>/g)].slice(0, MAX_SERIES)) series.push({ data: decodeXml(match[1]) });
  }
  const shape = [direction === 'bar' ? 'horizontal' : direction === 'col' ? 'vertical' : '', grouping && grouping !== 'standard' ? grouping : '']
    .filter(Boolean).join(', ');
  return { type: `${kinds.join(' + ') || 'chart'}${shape ? ` (${shape})` : ''}`, title, series };
}

class Collector {
  readonly pictures: OfficePicture[] = [];
  readonly charts: OfficeChart[] = [];
  private readonly byPart = new Map<string, OfficePicture>();
  private readonly entries: ZipEntries;

  constructor(entries: ZipEntries) {
    this.entries = entries;
  }

  /** Number a picture (or a video or sound) at its first use; `inBody` when the body places it. */
  picture(part: string, where: string, inBody = true): number | null {
    const bytes = this.entries[part];
    if (!bytes) return null;
    let picture = this.byPart.get(part);
    if (!picture) {
      const format = (part.split('.').pop() ?? '').toLowerCase();
      const media = VIDEO.has(format) ? 'video' : AUDIO.has(format) ? 'audio' : undefined;
      const size = media ? null : pictureSize(bytes);
      picture = {
        index: this.pictures.length + 1, part, format, bytes: bytes.length,
        ...(size ? { width: size.width, height: size.height } : {}),
        where: [], renderable: !media && RENDERABLE.has(format), ...(media ? { media } : {}), inBody,
      };
      this.byPart.set(part, picture);
      this.pictures.push(picture);
    }
    if (inBody) picture.inBody = true;
    if (where && !picture.where.includes(where)) picture.where.push(where);
    return picture.index;
  }

  chart(part: string, where: string): number | null {
    if (!this.entries[part] || this.charts.length >= MAX_CHARTS) return null;
    const index = this.charts.length + 1;
    this.charts.push({ index, where, ...readChart(this.entries, part) });
    return index;
  }

  has(part: string): boolean {
    return this.byPart.has(part);
  }
}

/** Where a part that only a header, layout or master uses shows up. */
function elsewhere(part: string): string {
  if (/^word\/header\d*\.xml$/.test(part)) return 'page header';
  if (/^word\/footer\d*\.xml$/.test(part)) return 'page footer';
  if (/^word\/(footnotes|endnotes|comments)\.xml$/.test(part)) return part.slice(5, -4);
  if (/^xl\/drawings\/vmlDrawing/.test(part)) return 'page header or footer';
  if (/slideLayouts\//.test(part)) return 'slide layout';
  if (/slideMasters\//.test(part)) return 'slide master';
  if (/notesSlides\//.test(part)) return 'speaker notes';
  if (/\/(charts|diagrams)\//.test(part)) return 'inside a chart or diagram';
  return 'linked but not placed';
}

/** Media not reached from the body: list it with the parts that use it, or as unused. */
function addRemainingMedia(entries: ZipEntries, collector: Collector, alternates: ReadonlySet<string>): void {
  const users = new Map<string, string[]>();
  for (const relsPart of Object.keys(entries)) {
    const match = /^(.*)_rels\/([^/]+)\.rels$/.exec(relsPart);
    if (!match) continue;
    const owner = `${match[1]}${match[2]}`;
    for (const { part } of relationships(entries, owner).values()) {
      const list = users.get(part) ?? [];
      const place = elsewhere(owner);
      if (!list.includes(place)) list.push(place);
      users.set(part, list);
    }
  }
  for (const part of Object.keys(entries).sort()) {
    if (!/^(word|xl|ppt)\/media\//.test(part) || collector.has(part) || alternates.has(part)) continue;
    const places = users.get(part);
    for (const place of places?.length ? places : ['not used in the document']) collector.picture(part, place, false);
  }
}

function embeddedObjects(entries: ZipEntries): string[] {
  return Object.keys(entries)
    .filter((part) => /^(word|xl|ppt)\/embeddings\/[^/]+$/.test(part))
    .map((part) => part.split('/').pop() ?? part)
    .sort();
}

/** SVG copies Office keeps beside a PNG picture: the PNG is listed, the copy is not. */
function svgAlternates(entries: ZipEntries, part: string, rels: Map<string, Relationship>, into: Set<string>): void {
  for (const match of xml(entries, part).matchAll(/<asvg:svgBlip\b[^>]*?r:embed="([^"]+)"/g)) {
    const target = rels.get(match[1]);
    if (target) into.add(target.part);
  }
}

const DOCX_TOKEN = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>|<a:blip\b[^>]*?r:embed="([^"]+)"|<v:imagedata\b[^>]*?r:id="([^"]+)"|<c:chart\b[^>]*?r:id="([^"]+)"/g;

function readDocx(entries: ZipEntries): OfficeManifest {
  const collector = new Collector(entries);
  const part = 'word/document.xml';
  const rels = relationships(entries, part);
  const alternates = new Set<string>();
  svgAlternates(entries, part, rels, alternates);
  const lines: string[] = [];
  for (const paragraph of withoutFallbacks(xml(entries, part)).split(/<w:p[\s>]/)) {
    let line = '';
    for (const match of paragraph.matchAll(DOCX_TOKEN)) {
      const [token, text, blip, vml, chart] = match;
      if (text !== undefined) line += decodeXml(text);
      else if (token.startsWith('<w:tab')) line += '\t';
      else if (token.startsWith('<w:br') || token.startsWith('<w:cr')) line += '\n';
      else if (blip || vml) {
        const target = rels.get(blip ?? vml);
        const index = target ? collector.picture(target.part, 'in the text') : null;
        if (index) line += `[Image ${index}]`;
      } else if (chart) {
        const target = rels.get(chart);
        const index = target ? collector.chart(target.part, 'in the text') : null;
        if (index) line += `[Chart ${index}]`;
      }
    }
    if (line.trim()) lines.push(line);
  }
  addRemainingMedia(entries, collector, alternates);
  return {
    kind: 'docx', pictures: collector.pictures, charts: collector.charts, embeddedObjects: embeddedObjects(entries),
    text: lines.join('\n'),
  };
}

function readXlsx(entries: ZipEntries): OfficeManifest {
  const collector = new Collector(entries);
  const alternates = new Set<string>();
  const workbookRels = relationships(entries, 'xl/workbook.xml');
  const sheets: NonNullable<OfficeManifest['sheets']> = [];
  for (const match of xml(entries, 'xl/workbook.xml').matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const attrs = attributes(match[1]);
    const name = decodeXml(attrs.name ?? '');
    const sheetPart = workbookRels.get(attrs['r:id'] ?? '');
    sheets.push({
      name, hidden: attrs.state === 'hidden' || attrs.state === 'veryHidden', chartsheet: sheetPart?.type === 'chartsheet',
    });
    if (!sheetPart) continue;
    for (const drawing of relationships(entries, sheetPart.part).values()) {
      if (drawing.type !== 'drawing') continue;
      const drawingRels = relationships(entries, drawing.part);
      svgAlternates(entries, drawing.part, drawingRels, alternates);
      const anchors = withoutFallbacks(xml(entries, drawing.part))
        .matchAll(/<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/xdr:\1>/g);
      for (const anchor of anchors) {
        const body = anchor[0];
        const column = /<xdr:col>(\d+)<\/xdr:col>/.exec(body)?.[1];
        const row = /<xdr:row>(\d+)<\/xdr:row>/.exec(body)?.[1];
        const where = `sheet '${name}'${column !== undefined && row !== undefined ? ` at ${columnName(Number(column))}${Number(row) + 1}` : ''}`;
        for (const blip of body.matchAll(/<a:blip\b[^>]*?r:embed="([^"]+)"/g)) {
          const target = drawingRels.get(blip[1]);
          if (target) collector.picture(target.part, where);
        }
        for (const chart of body.matchAll(/<(?:c|cx):chart\b[^>]*?r:id="([^"]+)"/g)) {
          const target = drawingRels.get(chart[1]);
          if (target) collector.chart(target.part, where);
        }
      }
    }
  }
  addRemainingMedia(entries, collector, alternates);
  return {
    kind: 'xlsx', pictures: collector.pictures, charts: collector.charts, embeddedObjects: embeddedObjects(entries), sheets,
  };
}

function readPptx(entries: ZipEntries): OfficeManifest {
  const collector = new Collector(entries);
  const alternates = new Set<string>();
  const presentationRels = relationships(entries, 'ppt/presentation.xml');
  const slides: NonNullable<OfficeManifest['slides']> = [];
  const ids = [...xml(entries, 'ppt/presentation.xml').matchAll(/<p:sldId\b[^>]*?r:id="([^"]+)"/g)].map((m) => m[1]);
  ids.forEach((id, i) => {
    const slidePart = presentationRels.get(id);
    const slide = { lines: [] as string[], pictures: [] as number[], charts: [] as number[] };
    slides.push(slide);
    if (!slidePart) return;
    const rels = relationships(entries, slidePart.part);
    svgAlternates(entries, slidePart.part, rels, alternates);
    const body = withoutFallbacks(xml(entries, slidePart.part));
    for (const paragraph of body.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
      const line = decodeXml([...paragraph[1].matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\b/g)].map((m) => m[1] ?? '\n').join(''));
      if (line.trim()) slide.lines.push(line);
    }
    for (const blip of body.matchAll(/<a:blip\b[^>]*?r:embed="([^"]+)"/g)) {
      const target = rels.get(blip[1]);
      const index = target ? collector.picture(target.part, `slide ${i + 1}`) : null;
      if (index && !slide.pictures.includes(index)) slide.pictures.push(index);
    }
    for (const chart of body.matchAll(/<(?:c|cx):chart\b[^>]*?r:id="([^"]+)"/g)) {
      const target = rels.get(chart[1]);
      const index = target ? collector.chart(target.part, `slide ${i + 1}`) : null;
      if (index) slide.charts.push(index);
    }
    // A video or sound sits on the slide behind its poster picture.
    for (const target of rels.values()) {
      if (!MEDIA_RELATIONSHIPS.has(target.type)) continue;
      const index = collector.picture(target.part, `slide ${i + 1}`);
      if (index && !slide.pictures.includes(index)) slide.pictures.push(index);
    }
  });
  addRemainingMedia(entries, collector, alternates);
  return { kind: 'pptx', pictures: collector.pictures, charts: collector.charts, embeddedObjects: embeddedObjects(entries), slides };
}

/** The manifest of an unzipped Office file, or null when it is none of the three kinds. */
export function readOfficeManifest(entries: ZipEntries): OfficeManifest | null {
  if (entries['word/document.xml']) return readDocx(entries);
  if (entries['xl/workbook.xml']) return readXlsx(entries);
  if (entries['ppt/presentation.xml']) return readPptx(entries);
  return null;
}
