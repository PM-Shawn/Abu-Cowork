import { describe, expect, it } from 'vitest';
import { resolveBrowserPermissionDefault } from './browserPermissionDefaults';

const decisions = ['allow', 'ask', 'deny'] as const;
const overrides = ['inherit', 'allow', 'ask', 'deny'] as const;
const resources = ['browse', 'upload', 'script'] as const;

describe('resolveBrowserPermissionDefault', () => {
  for (const resource of resources) {
    for (const defaultDecision of decisions) {
      const defaults = { browse: defaultDecision, upload: defaultDecision, script: defaultDecision };
      it(`${resource}/${defaultDecision}: unknown site inherits default`, () => {
        expect(resolveBrowserPermissionDefault({ defaults, resource, siteBlocked: false }))
          .toEqual({ decision: defaultDecision, source: 'default' });
      });
      for (const siteOverride of overrides) {
        it(`${resource}/${defaultDecision}/${siteOverride}: follows explicit priority`, () => {
          const input = { defaults, resource, siteOverride, siteBlocked: false };
          expect(resolveBrowserPermissionDefault(input)).toEqual({
            decision: siteOverride === 'inherit' ? defaultDecision : siteOverride,
            source: siteOverride === 'inherit' ? 'default' : 'site',
          });
          expect(resolveBrowserPermissionDefault({ ...input, siteBlocked: true }))
            .toEqual({ decision: 'deny', source: 'site-block' });
        });
      }
    }
  }
  it('does not confuse upload and browsing defaults', () => {
    const defaults = { browse: 'allow', upload: 'ask', script: 'deny' } as const;
    expect(resolveBrowserPermissionDefault({ defaults, resource: 'upload', siteBlocked: false }))
      .toEqual({ decision: 'ask', source: 'default' });
  });
});
