import { useState, useEffect } from 'react';
import { useI18n } from '@/i18n';
import { redactFailureText } from '@/core/diagnostic/scrub';
import { InlineMessage } from '@/components/ds/inline-message';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { cn } from '@/lib/utils';
import DataTable from './DataTable';

const MAX_ROWS = 1000;

/** Draws the bytes of a workbook. A new `data` replaces the sheets on screen once it is parsed. */
export default function XlsxPreview({ data }: { data: Uint8Array<ArrayBuffer> }) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [sheets, setSheets] = useState<{ name: string; headers: string[]; rows: string[][]; totalRows: number }[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(data, { type: 'array' });

        if (cancelled) return;

        const parsed = workbook.SheetNames.map(name => {
          const sheet = workbook.Sheets[name];
          const json = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' });
          const allRows = json as string[][];
          const headers = allRows[0]?.map(String) ?? [];
          const dataRows = allRows.slice(1).map(row => row.map(String));
          const totalRows = dataRows.length;
          const rows = dataRows.slice(0, MAX_ROWS);
          return { name, headers, rows, totalRows };
        });

        setSheets(parsed);
        // The same file read again keeps the sheet in view while it still exists.
        setActiveSheet((index) => (index < parsed.length ? index : 0));
        setFailed(false);
      } catch (err) {
        if (cancelled) return;
        console.error('[XlsxPreview] Failed to parse:', redactFailureText(err instanceof Error ? err.message : String(err)));
        setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [data]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label={t.panel.loadingDocument} />
      </div>
    );
  }

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <InlineMessage tone="danger">{t.panel.failedToReadFile}</InlineMessage>
      </div>
    );
  }

  const current = sheets[activeSheet];
  if (!current) return null;

  return (
    <div className="flex h-full flex-col">
      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-separator px-2 py-1">
          {sheets.map((s, i) => (
            <Pressable
              key={s.name}
              aria-pressed={i === activeSheet}
              onClick={() => setActiveSheet(i)}
              className={cn(
                // The strip scrolls sideways, so the focus ring is drawn inside the button.
                'h-6 shrink-0 whitespace-nowrap rounded-control px-2 text-ui-sm transition-colors duration-fast focus-visible:ring-inset',
                i === activeSheet ? 'bg-fill-selected font-medium text-label' : 'text-label-secondary hover:bg-fill-hover',
              )}
            >
              {s.name}
            </Pressable>
          ))}
        </div>
      )}
      {/* Table */}
      <div className="min-h-0 flex-1">
        <DataTable
          headers={current.headers}
          rows={current.rows}
          totalRows={current.totalRows}
        />
      </div>
    </div>
  );
}
