import { useI18n } from '@/i18n';
import { format } from '@/i18n';
import { ScrollArea } from '@/components/ds/scroll-area';

/** Generate Excel-style column labels: A, B, ..., Z, AA, AB, ... */
function columnLabel(index: number): string {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

export default function DataTable({ headers, rows, totalRows }: {
  headers: string[];
  rows: string[][];
  totalRows?: number;
}) {
  const { t } = useI18n();

  if (headers.length === 0 && rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-ui text-label-tertiary">
        {t.panel.csvNoData}
      </div>
    );
  }

  const showingIndicator = totalRows !== undefined && totalRows > rows.length;

  return (
    <div className="flex h-full flex-col">
      {showingIndicator && (
        <div className="shrink-0 border-b border-separator px-3 py-1 text-caption text-label-tertiary">
          {format(t.panel.xlsxRowsShowing, { shown: String(rows.length), total: String(totalRows) })}
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-ui-sm">
            <thead>
              <tr className="sticky top-0 z-sticky bg-code">
                {headers.map((h, i) => (
                  <th
                    key={i}
                    className="whitespace-nowrap border-b border-r border-separator px-3 py-2 text-left font-medium text-label"
                  >
                    {h || columnLabel(i)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="odd:bg-surface even:bg-code">
                  {headers.map((_, ci) => (
                    <td
                      key={ci}
                      className="max-w-75 truncate whitespace-nowrap border-b border-r border-separator px-3 py-1 text-label"
                    >
                      {row[ci] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ScrollArea>
    </div>
  );
}
