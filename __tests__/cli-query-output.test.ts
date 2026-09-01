import { describe, expect, it } from 'vitest';
import { formatQueryLocation } from '../src/cli/query-output';

describe('codegraph query source locations', () => {
  it('prints the inclusive definition range for a multiline symbol', () => {
    expect(formatQueryLocation('src/rcm_cru_cfg.h', 45, 78))
      .toBe('src/rcm_cru_cfg.h:45-78');
  });

  it('keeps both bounds for a single-line symbol', () => {
    expect(formatQueryLocation('src/constants.ts', 12, 12))
      .toBe('src/constants.ts:12-12');
  });

  it('does not emit a reversed range for malformed legacy data', () => {
    expect(formatQueryLocation('src/legacy.c', 20, 0))
      .toBe('src/legacy.c:20-20');
  });
});
