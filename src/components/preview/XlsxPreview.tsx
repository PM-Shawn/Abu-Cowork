import { useState, useEffect } from 'react';
import { readFile } from '@tauri-apps/plugin-fs';
import { useI18n } from '@/i18n';
import { Loader2 } from 'lucide-react';
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
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 text-[var(--abu-clay)] animate-spin" />
        <span className="ml-2 text-[13px] text-[var(--abu-text-tertiary)]">{t.panel.loadingDocument}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <p className="text-[13px] text-red-500">{error}</p>
      </div>
    );
  }

  const current = sheets[activeSheet];
  if (!current) return null;

  return (
    <div className="flex flex-col h-full bg-[var(--abu-bg-base)]">
      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div className="shrink-0 flex gap-0 border-b border-[var(--abu-bg-pressed)] overflow-x-auto bg-[var(--abu-bg-muted)]">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              onClick={() => setActiveSheet(i)}
              className={`px-3 py-1.5 text-[11px] border-r border-[var(--abu-bg-pressed)] whitespace-nowrap transition-colors ${
                i === activeSheet
                  ? 'bg-[var(--abu-bg-base)] text-[var(--abu-text-primary)] font-medium'
                  : 'text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-hover)]'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {/* Table */}
      <div className="flex-1 min-h-0">
        <DataTable
          headers={current.headers}
          rows={current.rows}
          totalRows={current.totalRows}
        />
      </div>
    </div>
  );
}
