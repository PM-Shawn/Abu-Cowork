const SPEC_QUARANTINE_MARKER = /QUARANTINED:/g;
const SPEC_QUARANTINE_FIXME = /test\.fixme\s*\(\s*true\s*,\s*(['"`])QUARANTINED: (https?:\/\/\S+) \((\d{4}-\d{2}-\d{2})\)\1\s*\)/g;

export interface SpecQuarantine {
  issueUrl: string;
  date: string;
}

function parseUtcDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? date : null;
}

export function inspectSpecQuarantines(
  filename: string,
  content: string,
  asOf: Date,
  slaDays = 28,
): SpecQuarantine[] {
  const markerCount = [...content.matchAll(SPEC_QUARANTINE_MARKER)].length;
  const quarantines = [...content.matchAll(SPEC_QUARANTINE_FIXME)].map((match) => ({
    issueUrl: match[2],
    date: match[3],
  }));

  if (quarantines.length !== markerCount) {
    throw new Error(
      `${filename}: every QUARANTINED marker must use ` +
        "test.fixme(true, 'QUARANTINED: <issue-url> (YYYY-MM-DD)')",
    );
  }

  const slaMs = slaDays * 24 * 60 * 60 * 1000;
  for (const quarantine of quarantines) {
    const quarantineDate = parseUtcDate(quarantine.date);
    if (!quarantineDate) {
      throw new Error(`${filename}: could not parse quarantine date "${quarantine.date}"`);
    }
    const ageMs = asOf.getTime() - quarantineDate.getTime();
    if (ageMs < 0) {
      throw new Error(
        `${filename}: quarantine date ${quarantine.date} is after as-of ` +
          asOf.toISOString().slice(0, 10),
      );
    }
    if (ageMs > slaMs) {
      throw new Error(
        `${filename}: quarantined on ${quarantine.date}, which exceeds the ${slaDays}-day SLA`,
      );
    }
  }

  return quarantines;
}
