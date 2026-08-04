import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

type Extracted = ReturnType<typeof extractFromSource>;

function nodes(result: Extracted, kind: string, name?: string) {
  return result.nodes.filter((node) => node.kind === kind && (name === undefined || node.name === name));
}

function containedMemberNames(result: Extracted, enumName: string): string[] {
  const enumNode = result.nodes.find((node) => node.kind === 'enum' && node.name === enumName);
  if (!enumNode) return [];
  const childIds = new Set(
    result.edges
      .filter((edge) => edge.kind === 'contains' && edge.source === enumNode.id)
      .map((edge) => edge.target),
  );
  return result.nodes
    .filter((node) => node.kind === 'enum_member' && childIds.has(node.id))
    .map((node) => node.name);
}

describe('self-including C/C++ X-macro enums', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
  });

  it.each([
    { language: 'c' as const, filePath: 'include/events.h' },
    { language: 'cpp' as const, filePath: 'include/events.hpp' },
  ])('recovers generated members and containment in $language', ({ language, filePath }) => {
    const includePath = language === 'c' ? 'project/include/events.h' : 'project/include/events.hpp';
    const source = `
#ifdef EVENT_ITEM
EVENT_ITEM(FIRST, 10, "first")
EVENT_ITEM(SECOND, nested(20, 30), "second")
#endif

enum EventCode {
  Invalid = 0,
#define EVENT_ITEM(name, metadata, description) name,
#include "${includePath}"
#undef EVENT_ITEM
  MaxCode
};
`;
    const result = extractFromSource(filePath, source, language);
    expect(nodes(result, 'enum', 'EventCode')).toHaveLength(1);
    expect(containedMemberNames(result, 'EventCode')).toEqual([
      'Invalid',
      'MaxCode',
      'FIRST',
      'SECOND',
    ]);
    for (const name of ['FIRST', 'SECOND']) {
      const [member] = nodes(result, 'enum_member', name);
      expect(member?.filePath).toBe(filePath);
      expect(member?.signature).toContain(`EVENT_ITEM(${name}`);
      expect(member?.docstring).toContain('self-including X-macro EVENT_ITEM');
    }
  });

  it('supports a non-first name parameter, continued definition, and multiline call', () => {
    const source = `
#if defined(ROW)
ROW(
  detail(pair(1, 2)),
  MULTILINE
)
ROW(other(3, 4), SECOND_VALUE)
// ROW(fake(), COMMENT_ONLY)
const char *text = "ROW(fake(), STRING_ONLY)";
#endif

struct Owner {
  enum class Kind : unsigned {
    Existing = 1,
#define ROW(metadata, name) \\
  name,
#include "kind.hpp"
#undef ROW
    End
  };
};
`;
    const result = extractFromSource('kind.hpp', source, 'cpp');
    expect(containedMemberNames(result, 'Kind')).toEqual([
      'Existing',
      'End',
      'MULTILINE',
      'SECOND_VALUE',
    ]);
    expect(nodes(result, 'enum_member', 'COMMENT_ONLY')).toHaveLength(0);
    expect(nodes(result, 'enum_member', 'STRING_ONLY')).toHaveLength(0);
  });

  it('deduplicates a generated name already present in the enum', () => {
    const source = `
#ifdef ITEM
ITEM(AlreadyPresent)
ITEM(Generated)
ITEM(Generated)
#endif
enum Values {
  AlreadyPresent,
#define ITEM(name) name,
#include "values.h"
#undef ITEM
};
`;
    const result = extractFromSource('values.h', source, 'c');
    expect(containedMemberNames(result, 'Values')).toEqual(['AlreadyPresent', 'Generated']);
    expect(nodes(result, 'enum_member', 'AlreadyPresent')).toHaveLength(1);
    expect(nodes(result, 'enum_member', 'Generated')).toHaveLength(1);
  });

  it('does not regress ordinary or conditionally compiled enums', () => {
    const source = `
enum Plain { A, B };
enum Conditional {
  Start,
#ifdef FEATURE
  Enabled,
#else
  Disabled,
#endif
  End
};
`;
    const result = extractFromSource('plain.h', source, 'c');
    expect(containedMemberNames(result, 'Plain')).toEqual(['A', 'B']);
    // The C grammar's established behavior is to retain the members outside
    // the conditional block. X-macro recovery must not flatten or alter it.
    expect(containedMemberNames(result, 'Conditional')).toEqual(['Start', 'End']);
  });

  it('uses only the positive matching guard branch as X-list data', () => {
    const source = `
#ifdef ITEM
ITEM(POSITIVE)
#else
ITEM(NEGATIVE)
#endif
void f(void) { ITEM(NORMAL_CODE); }
enum E {
#define ITEM(name) name,
#include "guarded.h"
#undef ITEM
};
`;
    const result = extractFromSource('guarded.h', source, 'c');
    expect(containedMemberNames(result, 'E')).toEqual(['POSITIVE']);
    expect(nodes(result, 'enum_member', 'NEGATIVE')).toHaveLength(0);
    expect(nodes(result, 'enum_member', 'NORMAL_CODE')).toHaveLength(0);
  });

  it.each([
    {
      name: 'external include',
      body: '#define ITEM(name) name,\n#include "other-list.inc"\n#undef ITEM',
    },
    {
      name: 'path traversal include',
      body: '#define ITEM(name) name,\n#include "../self.h"\n#undef ITEM',
    },
    {
      name: 'missing undef',
      body: '#define ITEM(name) name,\n#include "self.h"',
    },
    {
      name: 'ambiguous replacement',
      body: '#define ITEM(first, second) first, second,\n#include "self.h"\n#undef ITEM',
      invocation: 'ITEM(VALUE, OTHER)',
    },
    {
      name: 'token paste',
      body: '#define ITEM(name) PREFIX_##name,\n#include "self.h"\n#undef ITEM',
    },
    {
      name: 'stringify',
      body: '#define ITEM(name) #name,\n#include "self.h"\n#undef ITEM',
    },
    {
      name: 'non-identifier name argument',
      body: '#define ITEM(name) name,\n#include "self.h"\n#undef ITEM',
      invocation: 'ITEM(PREFIX + VALUE)',
    },
  ])('does not synthesize members for $name', ({ body, invocation }) => {
    const source = `
#ifdef ITEM
${invocation ?? 'ITEM(VALUE)'}
#endif
enum E {
${body}
};
`;
    const result = extractFromSource('self.h', source, 'c');
    expect(nodes(result, 'enum_member', 'VALUE')).toHaveLength(0);
    expect(nodes(result, 'enum_member', 'OTHER')).toHaveLength(0);
  });

  it('does not recover an unguarded lookalike call', () => {
    const source = `
ITEM(VALUE)
enum E {
#define ITEM(name) name,
#include "self.h"
#undef ITEM
};
`;
    const result = extractFromSource('self.h', source, 'cpp');
    expect(nodes(result, 'enum_member', 'VALUE')).toHaveLength(0);
  });

  it('does not treat a same-basename header in another directory as self-include', () => {
    const source = `
#ifdef ITEM
ITEM(VALUE)
#endif
enum E {
#define ITEM(name) name,
#include "other/self.h"
#undef ITEM
};
`;
    const result = extractFromSource('include/self.h', source, 'cpp');
    expect(nodes(result, 'enum_member', 'VALUE')).toHaveLength(0);
  });

  it('keeps generated members stable across indexAll and sync', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-xmacro-'));
    const header = path.join(dir, 'status.h');
    const source = `
#ifdef STATUS_ITEM
STATUS_ITEM(READY)
STATUS_ITEM(RUNNING)
#endif
enum Status {
#define STATUS_ITEM(name) name,
#include "status.h"
#undef STATUS_ITEM
};
`;
    let graph: CodeGraph | undefined;
    try {
      fs.writeFileSync(header, source);
      graph = await CodeGraph.init(dir, { silent: true });
      await graph.indexAll();

      const assertStableGraph = () => {
        const enumNode = graph!.getNodesByName('Status').find((node) => node.kind === 'enum');
        expect(enumNode).toBeDefined();
        const ready = graph!.getNodesByName('READY').filter((node) => node.kind === 'enum_member');
        const running = graph!.getNodesByName('RUNNING').filter((node) => node.kind === 'enum_member');
        expect(ready).toHaveLength(1);
        expect(running).toHaveLength(1);
        const outgoing = graph!.getOutgoingEdges(enumNode!.id);
        expect(outgoing.some((edge) => edge.kind === 'contains' && edge.target === ready[0]!.id)).toBe(true);
        expect(outgoing.some((edge) => edge.kind === 'contains' && edge.target === running[0]!.id)).toBe(true);
      };

      assertStableGraph();
      fs.appendFileSync(header, '\n// force incremental re-index\n');
      await graph.sync();
      assertStableGraph();
    } finally {
      graph?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps two enums reusing the same X-macro data table as independent members', () => {
    // Two enums in one file reuse the SAME macro name AND the SAME self-include
    // data table. Before the identity-salt fix, both synthesized members shared
    // one node id (generateNodeId(filePath, kind, name, line) had no enum
    // discriminator), so both enums' `contains` edges pointed at one node and
    // the second enum's qualifiedName clobbered the first.
    const source = `
#ifdef ITEM
ITEM(SHARED_A)
ITEM(SHARED_B)
#endif
enum First {
  FirstLit,
#define ITEM(name) name,
#include "self.h"
#undef ITEM
  FirstEnd
};
enum Second {
  SecondLit,
#define ITEM(name) name,
#include "self.h"
#undef ITEM
  SecondEnd
};
`;
    const result = extractFromSource('self.h', source, 'c');
    const firstEnum = nodes(result, 'enum', 'First')[0]!;
    const secondEnum = nodes(result, 'enum', 'Second')[0]!;
    expect(firstEnum).toBeDefined();
    expect(secondEnum).toBeDefined();

    // ① two synthesized members of the same name, one per enum, distinct ids
    const sharedA = nodes(result, 'enum_member', 'SHARED_A');
    const sharedB = nodes(result, 'enum_member', 'SHARED_B');
    expect(sharedA).toHaveLength(2);
    expect(sharedB).toHaveLength(2);
    expect(sharedA[0]!.id).not.toBe(sharedA[1]!.id);
    expect(sharedB[0]!.id).not.toBe(sharedB[1]!.id);

    const firstChildren = new Set(
      result.edges.filter((e) => e.kind === 'contains' && e.source === firstEnum.id).map((e) => e.target),
    );
    const secondChildren = new Set(
      result.edges.filter((e) => e.kind === 'contains' && e.source === secondEnum.id).map((e) => e.target),
    );
    const firstA = sharedA.find((m) => firstChildren.has(m.id))!;
    const secondA = sharedA.find((m) => secondChildren.has(m.id))!;

    // ② qualifiedName belongs to its own enum (not clobbered)
    expect(firstA.qualifiedName).toContain('First');
    expect(secondA.qualifiedName).toContain('Second');
    expect(firstA.qualifiedName).not.toBe(secondA.qualifiedName);

    // ③ each contains edge points to its own member only
    expect(firstChildren.has(firstA.id)).toBe(true);
    expect(firstChildren.has(secondA.id)).toBe(false);
    expect(secondChildren.has(secondA.id)).toBe(true);
    expect(secondChildren.has(firstA.id)).toBe(false);
  });

  it('keeps two-data-table members independent in the DB across indexAll and sync', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-xmacro2-'));
    const header = path.join(dir, 'self.h');
    const source = `
#ifdef ITEM
ITEM(SHARED_A)
ITEM(SHARED_B)
#endif
enum First {
  FirstLit,
#define ITEM(name) name,
#include "self.h"
#undef ITEM
  FirstEnd
};
enum Second {
  SecondLit,
#define ITEM(name) name,
#include "self.h"
#undef ITEM
  SecondEnd
};
`;
    let graph: CodeGraph | undefined;
    try {
      fs.writeFileSync(header, source);
      graph = await CodeGraph.init(dir, { silent: true });
      await graph.indexAll();

      // ④ after indexAll (and again after sync) the DB still holds two
      // independent SHARED_A nodes, each contained by its own enum
      const assertTwoIndependent = () => {
        const sharedA = graph!.getNodesByName('SHARED_A').filter((n) => n.kind === 'enum_member');
        expect(sharedA).toHaveLength(2);
        expect(sharedA[0]!.id).not.toBe(sharedA[1]!.id);
        const firstEnum = graph!.getNodesByName('First').find((n) => n.kind === 'enum');
        const secondEnum = graph!.getNodesByName('Second').find((n) => n.kind === 'enum');
        expect(firstEnum).toBeDefined();
        expect(secondEnum).toBeDefined();
        const firstHas = new Set(
          graph!.getOutgoingEdges(firstEnum!.id).filter((e) => e.kind === 'contains').map((e) => e.target),
        );
        const secondHas = new Set(
          graph!.getOutgoingEdges(secondEnum!.id).filter((e) => e.kind === 'contains').map((e) => e.target),
        );
        const inFirst = sharedA.filter((m) => firstHas.has(m.id));
        const inSecond = sharedA.filter((m) => secondHas.has(m.id));
        expect(inFirst).toHaveLength(1);
        expect(inSecond).toHaveLength(1);
        expect(inFirst[0]!.id).not.toBe(inSecond[0]!.id);
      };

      assertTwoIndependent();
      fs.appendFileSync(header, '\n// force incremental re-index\n');
      await graph.sync();
      assertTwoIndependent();
    } finally {
      graph?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips impossible members inside a nested #if 0 / #else under the X-macro guard', () => {
    const source = `
#ifdef ITEM
#if 0
ITEM(INACTIVE)
#else
ITEM(ACTIVE)
#endif
#endif
enum E {
  EStart,
#define ITEM(name) name,
#include "self.h"
#undef ITEM
  EEnd
};
`;
    const result = extractFromSource('self.h', source, 'c');
    expect(containedMemberNames(result, 'E')).toEqual(['EStart', 'EEnd', 'ACTIVE']);
    expect(nodes(result, 'enum_member', 'INACTIVE')).toHaveLength(0);
    expect(nodes(result, 'enum_member', 'ACTIVE')).toHaveLength(1);
  });

  it('does not cross-synthesize from A/B selector guards that are not provably active', () => {
    const source = `
#if defined(ITEM) && defined(LIST_A)
ITEM(A_ONLY)
#endif
#if defined(ITEM) && defined(LIST_B)
ITEM(B_ONLY)
#endif
enum E {
  EStart,
#define ITEM(name) name,
#include "self.h"
#undef ITEM
  EEnd
};
`;
    const result = extractFromSource('self.h', source, 'c');
    expect(nodes(result, 'enum_member', 'A_ONLY')).toHaveLength(0);
    expect(nodes(result, 'enum_member', 'B_ONLY')).toHaveLength(0);
    // The construct's directives are blanked to recover the enum shell +
    // hand-written members; no generated members are synthesized (unprovable guard).
    expect(containedMemberNames(result, 'E')).toEqual(['EStart', 'EEnd']);
  });

  it('ignores macro calls inside a C++ raw string literal', () => {
    const source = `
#ifdef ITEM
ITEM(REAL)
const char *text = R"x(ITEM(GHOST))x";
#endif
enum E {
  EStart,
#define ITEM(name) name,
#include "self.h"
#undef ITEM
  EEnd
};
`;
    const result = extractFromSource('self.h', source, 'cpp');
    expect(containedMemberNames(result, 'E')).toEqual(['EStart', 'EEnd', 'REAL']);
    expect(nodes(result, 'enum_member', 'REAL')).toHaveLength(1);
    expect(nodes(result, 'enum_member', 'GHOST')).toHaveLength(0);
  });

  it('ignores fake directives and calls inside a raw string with embedded quotes', () => {
    // The raw string contains an embedded `"` and a fake `#ifdef ITEM` /
    // `ITEM(GHOST)`. The old plain-string scanner would close on the embedded
    // quote and then treat the fake directive/call as real; the shared
    // non-code range scan must skip the whole raw literal instead.
    const source = `
#ifdef ITEM
ITEM(REAL)
const char *text = R"x(" #ifdef ITEM
ITEM(GHOST)
#endif)x";
#endif
enum E {
  EStart,
#define ITEM(name) name,
#include "self.h"
#undef ITEM
  EEnd
};
`;
    const result = extractFromSource('self.h', source, 'cpp');
    expect(containedMemberNames(result, 'E')).toEqual(['EStart', 'EEnd', 'REAL']);
    expect(nodes(result, 'enum_member', 'REAL')).toHaveLength(1);
    expect(nodes(result, 'enum_member', 'GHOST')).toHaveLength(0);
  });

  it('parses a raw string as a single macro argument without splitting on inner quotes', () => {
    // `ITEM(R"x(", GHOST, blah)x", REAL)` — the first argument is a raw string
    // that itself contains quotes, commas, and parens. parseCallArgs must treat
    // it as one argument (text) and pick the second argument (REAL) as the name,
    // not GHOST.
    const source = `
#ifdef ITEM
ITEM(R"x(", GHOST, blah)x", REAL)
#endif
enum E {
  EStart,
#define ITEM(text, name) name,
#include "self.h"
#undef ITEM
  EEnd
};
`;
    const result = extractFromSource('self.h', source, 'cpp');
    expect(containedMemberNames(result, 'E')).toEqual(['EStart', 'EEnd', 'REAL']);
    expect(nodes(result, 'enum_member', 'REAL')).toHaveLength(1);
    expect(nodes(result, 'enum_member', 'GHOST')).toHaveLength(0);
  });

  it('does not treat definedITEM or unbalanced parentheses as a guard for M', () => {
    // `definedITEM` (no space), `defined(ITEM` (unbalanced open), and
    // `defined ITEM)` (unbalanced close) must NOT be recognized as `defined M`,
    // or the fake `#if definedITEM` block would leak its members into the enum.
    const cases = ['definedITEM', 'defined(ITEM', 'defined ITEM)'];
    for (const guard of cases) {
      const source = `
#ifdef ITEM
#if ${guard}
ITEM(BAD)
#endif
ITEM(GOOD)
#endif
enum E {
  EStart,
#define ITEM(name) name,
#include "self.h"
#undef ITEM
  EEnd
};
`;
      const result = extractFromSource('self.h', source, 'c');
      expect(nodes(result, 'enum_member', 'BAD')).toHaveLength(0);
      expect(nodes(result, 'enum_member', 'GOOD')).toHaveLength(1);
    }
  });
});
