import { useSettingsStore } from '@/stores/settingsStore';
import type { AnnouncementItem } from '@/utils/consoleAnnouncement';
import AnnouncementBanner from './AnnouncementBanner';
import DisclaimerBanner from './DisclaimerBanner';

// The two banners share the bottom-right corner, so one shows at a time: the disclaimer first,
// because it asks for an acknowledgement, and the announcement once that has been given.
export default function CornerBanners({
  announcement,
  onDismissAnnouncement,
}: {
  announcement: AnnouncementItem | undefined;
  onDismissAnnouncement: () => void;
}) {
  const acknowledged = useSettingsStore((s) => s.hasAcknowledgedDisclaimer);
  return (
    <>
      <DisclaimerBanner />
      {acknowledged && announcement && <AnnouncementBanner item={announcement} onDismiss={onDismissAnnouncement} />}
    </>
  );
}
