import { useI18n } from '@/i18n';
import { format } from '@/i18n';
import { ScrollArea } from '@/components/ui/scroll-area';

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
      <div className="flex items-center justify-center h-full text-[13px] text-[var(--abu-text-tertiary)]">
        {t.panel.csvNoData}
      </div>
    );
  }

  const showingIndicator = totalRows !== undefined && totalRows > rows.length;

  return (
    <div className="flex flex-col h-full">
      {showingIndicator && (
        <div className="shrink-0 px-3 py-1.5 text-[11px] text-[var(--abu-text-tertiary)] bg-[var(--abu-bg-muted)] border-b border-[var(--abu-bg-pressed)]">
          {format(t.panel.xlsxRowsShowing, { shown: String(rows.length), total: String(totalRows) })}
        </div>
      )}
      <ScrollArea className="flex-1 min-h-0">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="sticky top-0 z-10 bg-[var(--abu-bg-muted)]">
                {headers.map((h, i) => (
                  <th
                    key={i}
                    className="px-3 py-2 text-left font-semibold text-[var(--abu-text-primary)] border-b border-r border-[var(--abu-bg-pressed)] whitespace-nowrap"
                  >
                    {h || columnLabel(i)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className={ri % 2 === 0 ? 'bg-[var(--abu-bg-base)]' : 'bg-[var(--abu-bg-muted)]'}>
                  {headers.map((_, ci) => (
                    <td
                      key={ci}
                      className="px-3 py-1.5 text-[var(--abu-text-primary)] border-b border-r border-[var(--abu-bg-pressed)] whitespace-nowrap max-w-[300px] truncate"
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
