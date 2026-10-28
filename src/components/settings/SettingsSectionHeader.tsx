import { useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SettingsHeaderContext } from './settingsHeaderContext';

/**
 * Section titles and actions occupy the settings window's fixed header.
 * Descriptions stay with the form; standalone sections render their own header.
 */
export default function SettingsSectionHeader({
  title,
  description,
  action,
  titleAccessory,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  titleAccessory?: ReactNode;
}) {
  const host = useContext(SettingsHeaderContext);
  const heading = (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="truncate text-title text-label">{title}</h3>
        {titleAccessory}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
  const explanation = description && <p className="text-ui-sm text-label-secondary">{description}</p>;
  if (host !== undefined) return <>{host && createPortal(heading, host)}{explanation}</>;
  return <div className="space-y-1">{heading}{explanation}</div>;
}
