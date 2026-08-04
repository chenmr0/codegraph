import { describe, expect, it } from 'vitest';
import { scoreSearchNodes } from './scoring.js';
import type { ExpectedSearchSymbol } from './types.js';

const expected: ExpectedSearchSymbol = {
  name: 'Status',
  kind: 'enum',
  filePath: 'src/protocol/status.h',
};

function result(
  name: string,
  kind: 'enum' | 'function',
  filePath: string,
  qualifiedName = name,
) {
  return { node: { name, kind, filePath, qualifiedName }, score: 1 };
}

describe('strict search evaluation identity gate', () => {
  it('rejects a same-name node with the wrong kind', () => {
    const scored = scoreSearchNodes(
      'wrong-kind',
      [expected],
      [result('Status', 'function', 'src/protocol/status.h')],
      1,
    );

    expect(scored.pass).toBe(false);
    expect(scored.recall).toBe(0);
  });

  it('rejects a duplicate basename from a different directory', () => {
    const scored = scoreSearchNodes(
      'wrong-path',
      [expected],
      [result('Status', 'enum', 'tests/fixtures/status.h')],
      1,
    );

    expect(scored.pass).toBe(false);
    expect(scored.recall).toBe(0);
  });

  it('normalizes path separators but requires the complete relative path', () => {
    const scored = scoreSearchNodes(
      'exact-identity',
      [expected],
      [
        result('Other', 'enum', 'src/other.h'),
        result('Status', 'enum', 'tests/fixtures/status.h'),
        result('Status', 'enum', 'src\\protocol\\status.h'),
      ],
      1,
    );

    expect(scored.pass).toBe(true);
    expect(scored.recall).toBe(1);
    expect(scored.mrr).toBeCloseTo(1 / 3);
  });

  it('requires every expected search symbol instead of passing at 50% recall', () => {
    const scored = scoreSearchNodes(
      'all-required',
      [expected, { name: 'Mode', kind: 'enum', filePath: 'src/protocol/mode.h' }],
      [result('Status', 'enum', 'src/protocol/status.h')],
      1,
    );

    expect(scored.recall).toBe(0.5);
    expect(scored.pass).toBe(false);
  });

  it('uses qualifiedName when the expectation supplies one', () => {
    const qualified = { ...expected, qualifiedName: 'protocol::Status' };
    const scored = scoreSearchNodes(
      'qualified',
      [qualified],
      [result('Status', 'enum', 'src/protocol/status.h', 'other::Status')],
      1,
    );

    expect(scored.pass).toBe(false);
  });
});
