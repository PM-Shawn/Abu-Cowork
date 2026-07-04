/**
 * Shared header for settings sections. Renders the plain `<h3>` title style
 * used by Models / Channels / Memory so every panel's heading looks the same.
 */
export default function SettingsSectionHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div>
      <h3 className="text-base font-semibold text-[var(--abu-text-primary)]">{title}</h3>
      {description && (
        <p className="text-xs text-[var(--abu-text-muted)] mt-1">{description}</p>
      )}
    </div>
  );
}
