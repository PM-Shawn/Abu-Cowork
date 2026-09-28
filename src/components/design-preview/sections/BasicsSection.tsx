import { Avatar } from '@/components/ds/avatar';
import { Button, IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { Kbd } from '@/components/ds/kbd';
import { Link } from '@/components/ds/link';
import { Separator } from '@/components/ds/separator';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon, type StatusTone } from '@/components/ds/status-icon';
import { Tag } from '@/components/ds/tag';
import { Section } from './Section';
import { PREVIEW_AVATAR_IMAGE } from './specimen';

const VARIANTS = ['primary', 'secondary', 'plain', 'danger'] as const;
const TONES: StatusTone[] = ['success', 'warning', 'danger', 'info'];

export function BasicsSection() {
  return (
    <Section id="basics" title="Buttons and basics">
      <div className="flex flex-col gap-3">
        {(['md', 'sm'] as const).map((size) => (
          <div key={size} className="flex items-center gap-2">
            {VARIANTS.map((variant) => <Button key={variant} variant={variant} size={size}>{variant}</Button>)}
            <Button size={size} icon={AppIcons.add}>With icon</Button>
            <Button size={size} disabled>Disabled</Button>
            <IconButton size={size} icon={AppIcons.more} label="Show more actions" />
            <IconButton size={size} variant="secondary" icon={AppIcons.copy} label="Copy code" />
          </div>
        ))}
        <div className="flex items-center gap-4">
          <Link href="https://example.com">Open documentation</Link>
          <span className="flex items-center gap-1 text-ui text-label-secondary">Search <Kbd>⌘K</Kbd></span>
          <Tag>Draft</Tag>
          <Tag tone="success">Done</Tag>
          <Tag tone="warning">Expiring</Tag>
          <Tag tone="danger">Failed</Tag>
          <Tag tone="info">New</Tag>
          <Avatar name="Sam" size="sm" />
          <Avatar name="Abu" />
          <Avatar name="Shawn" size="lg" />
          <Avatar name="Photo avatar" src={PREVIEW_AVATAR_IMAGE} size="lg" />
        </div>
        <Separator decorative={false} />
        <div className="flex h-6 items-center gap-4">
          <Spinner label="Saving" size="sm" />
          <Spinner label="Reading 9 files" />
          <Spinner label="Loading the task" size="lg" />
          <Spinner label="Syncing" labelHidden />
          <Separator orientation="vertical" decorative={false} />
          {TONES.map((tone) => <StatusIcon key={tone} tone={tone} label={tone} />)}
        </div>
      </div>
    </Section>
  );
}
