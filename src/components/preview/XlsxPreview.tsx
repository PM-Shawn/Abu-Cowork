import { useState, useEffect } from 'react';
import { readFile } from '@tauri-apps/plugin-fs';
import { useI18n } from '@/i18n';
import { InlineMessage } from '@/components/ds/inline-message';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { cn } from '@/lib/utils';
import DataTable from './DataTable';

const MAX_ROWS = 1000;

export default function XlsxPreview({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<{ name: string; headers: string[]; rows: string[][]; totalRows: number }[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await readFile(filePath);
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
        setActiveSheet(0);
      } catch (err) {
        if (cancelled) return;
        console.error('[XlsxPreview] Failed to parse:', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [filePath]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label={t.panel.loadingDocument} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <InlineMessage tone="danger">{error}</InlineMessage>
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
