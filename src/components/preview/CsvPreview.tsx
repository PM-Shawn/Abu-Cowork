import { useMemo } from 'react';
import DataTable from './DataTable';

export type CsvDelimiter = ',' | '\t';

function parseCSV(text: string, delimiter: CsvDelimiter): { headers: string[]; rows: string[][] } {
  const lines: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        current.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        current.push(field);
        field = '';
        if (current.some(c => c !== '')) {
          lines.push(current);
        }
        current = [];
        if (ch === '\r' && text[i + 1] === '\n') i++;
      } else {
        field += ch;
      }
    }
  }
  // last field
  current.push(field);
  if (current.some(c => c !== '')) {
    lines.push(current);
  }

  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0];
  const rows = lines.slice(1);

  // Normalize row lengths to match headers
  const normalizedRows = rows.map(row => {
    if (row.length < headers.length) {
      return [...row, ...Array(headers.length - row.length).fill('')];
    }
    return row.slice(0, headers.length);
  });

  return { headers, rows: normalizedRows };
}

/** A table of delimiter-separated text: commas for CSV, tabs for TSV. */
export default function CsvPreview({ content, delimiter = ',' }: { content: string; delimiter?: CsvDelimiter }) {
  const { headers, rows } = useMemo(() => parseCSV(content, delimiter), [content, delimiter]);
  return <DataTable headers={headers} rows={rows} />;
}
