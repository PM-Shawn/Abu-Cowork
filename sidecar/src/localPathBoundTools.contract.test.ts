import { describe, expect, it } from 'vitest';
import { FILE_TOOL_PATH_MAP } from '@/core/tools/registry';
import { hasLocalTool } from './localTools';
import { LOCAL_PATH_BOUND_TOOLS } from './localPathBoundTools';

describe('LOCAL_PATH_BOUND_TOOLS ↔ FILE_TOOL_PATH_MAP sync', () => {
  it('contains exactly the path-checked file tools that execute locally', () => {
    const expected = Object.keys(FILE_TOOL_PATH_MAP).filter(hasLocalTool).sort();
    expect([...LOCAL_PATH_BOUND_TOOLS].sort()).toEqual(expected);
  });
});
