/**
 * C++ template type-parameter extraction.
 *
 * `Node.typeParameters` is now populated for templated C++ declarations via the
 * `LanguageExtractor.getTypeParameters` hook (only C++ defines it; every other
 * language is untouched). Each declaration stores only its OWN template
 * parameters: a class template's `T` must not leak onto its ordinary member
 * methods, while a member TEMPLATE keeps its own params and an out-of-line
 * member-template definition collects the consecutively nested
 * `template_declaration`s in source order. Only bare names are stored —
 * `class`/`typename`, default values, and constraint expressions are dropped,
 * and anonymous parameters are skipped. Extraction is AST-driven (field
 * lookups + controlled recursion), never a whole-signature regex.
 *
 * Also asserts that a temp project re-indexed via `indexAll` + `sync` keeps
 * `typeParameters` correct and duplicate-free.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';

/** All template constructs under test, with distinct names so each is queryable. */
const CPP_SOURCE = `
// 1. template class — own param T; member template (own U); ordinary member (none)
template <typename T>
class TClass {
public:
  T data;
  template <typename U>
  U mtemp(U x);
  template <typename U>
  U inline_mtemp(U x) { return x; }
  void plain();
};

// 2. template struct — named (Key), non-type (int N), pack (Args), default (U),
//    template-template (Container). Source order must be preserved.
template <typename Key, int N, typename... Args, typename U = int, template <typename> class Container>
struct TStruct {
  Key keys[N];
  Container<int> c;
};

// 3. template free function
template <typename T>
T identfn(T x) {
  return x;
}

// 4. template alias
template <typename T>
using TAlias = T;

// 5. out-of-line member-template definition — consecutively nested
//    template_declaration: outer T (class template) + inner U (member template).
template <typename T>
template <typename U>
U TClass<T>::mtemp(U x) {
  return x;
}

// 6. constrained parameter (requires-clause): name only, constraint dropped.
template <typename T>
  requires Eq<T>
class TConc {
public:
  T value;
};

// 7. ordinary non-template nodes — must have no typeParameters
struct PlainStruct {
  int x;
};
void plainfn() {
  int y = 0;
  (void)y;
}
`;

/** A plain C file: C has no templates and no getTypeParameters hook, so it
 *  must remain completely unaffected (type_parameters column NULL). */
const C_SOURCE = `
struct CStruct { int x; };
int cfunc(int a) { return a; }
`;

describe('C++ template typeParameters extraction', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-tp-'));
    fs.writeFileSync(path.join(dir, 'tmpl.hpp'), CPP_SOURCE);
    fs.writeFileSync(path.join(dir, 'plain.c'), C_SOURCE);
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const db = () => (cg as any).db.db;
  const find = (name: string, kind?: string) => {
    let rows = db().prepare('SELECT * FROM nodes WHERE name = ?').all(name) as any[];
    if (kind) rows = rows.filter((r) => r.kind === kind);
    return rows;
  };
  /** Assert exactly one node matches and return it. */
  const one = (name: string, kind?: string) => {
    const rows = find(name, kind);
    expect(rows.length, `expected exactly one ${kind ?? ''} '${name}'`).toBe(1);
    return rows[0];
  };
  const oneDefinition = (name: string, kind?: string) => {
    const rows = find(name, kind).filter((row) => !row.is_declaration);
    expect(rows.length, `expected exactly one ${kind ?? ''} definition '${name}'`).toBe(1);
    return rows[0];
  };
  /** Parse the raw type_parameters JSON column (NULL → undefined). */
  const tpOf = (row: any): string[] | undefined =>
    row.type_parameters ? (JSON.parse(row.type_parameters) as string[]) : undefined;

  it('template class carries its own param T', () => {
    expect(tpOf(one('TClass', 'class'))).toEqual(['T']);
  });

  it('template struct preserves source order across all parameter kinds', () => {
    expect(tpOf(one('TStruct', 'struct'))).toEqual([
      'Key', 'N', 'Args', 'U', 'Container',
    ]);
  });

  it('template free function carries its param', () => {
    expect(tpOf(one('identfn', 'function'))).toEqual(['T']);
  });

  it('template alias (using) carries its param', () => {
    expect(tpOf(one('TAlias', 'type_alias'))).toEqual(['T']);
  });

  it('ordinary non-template nodes have no typeParameters', () => {
    expect(tpOf(one('PlainStruct', 'struct'))).toBeUndefined();
    expect(tpOf(one('plainfn', 'function'))).toBeUndefined();
  });

  it('a class template\'s ordinary member does NOT inherit the class param T', () => {
    // `void plain();` is a member of TClass<T>, but T is the CLASS's template
    // param, not plain()'s own — so plain() must have no typeParameters.
    expect(tpOf(one('plain', 'method'))).toBeUndefined();
  });

  it('an inline member template carries U without inheriting class param T', () => {
    expect(tpOf(one('inline_mtemp', 'method'))).toEqual(['U']);
  });

  it('out-of-line member-template method collects nested template params [T, U]', () => {
    // `template <typename T> template <typename U> U TClass<T>::mtemp(U x) {}`
    // is represented as a method (receiver TClass<T>) wrapped by two consecutive
    // template_declarations — source order T then U → [T, U].
    expect(tpOf(oneDefinition('mtemp', 'method'))).toEqual(['T', 'U']);
  });

  it('a constrained parameter stores only its name, not the constraint', () => {
    // `template <typename T> requires Eq<T> class TConc {}` — if the grammar
    // parses the requires-clause, TConc exists with typeParameters ['T'] and
    // the constraint expression `Eq` must NOT appear. (Defensive: requires-
    // clause support varies across grammar builds — only assert when parsed.)
    const rows = find('TConc', 'class');
    if (rows.length === 0) return; // grammar build has no requires-clause support
    const tp = tpOf(rows[0]);
    expect(tp).toEqual(['T']);
    expect(tp).not.toContain('Eq');
  });

  it('C is unaffected: struct and function have no typeParameters', () => {
    expect(tpOf(one('CStruct', 'struct'))).toBeUndefined();
    expect(tpOf(one('cfunc', 'function'))).toBeUndefined();
  });

  it('no node has duplicate entries in its typeParameters', () => {
    const rows = db().prepare('SELECT name, kind, type_parameters FROM nodes').all() as any[];
    for (const r of rows) {
      const tp = r.type_parameters ? (JSON.parse(r.type_parameters) as string[]) : undefined;
      if (!tp) continue;
      expect(new Set(tp).size, `${r.kind} '${r.name}' typeParameters must be unique`).toBe(tp.length);
    }
  });

  it('indexAll + sync keeps typeParameters correct and duplicate-free', async () => {
    // Capture before re-index.
    const before = tpOf(one('TClass', 'class'));
    expect(before).toEqual(['T']);

    // Touch the header so its content hash changes, then re-index via sync.
    fs.appendFileSync(path.join(dir, 'tmpl.hpp'), '\n// trailing comment after sync\n');
    const result = await cg.sync();
    expect(result.filesModified, 'sync must re-index the modified header').toBeGreaterThanOrEqual(1);

    // Re-query: every assertion above must still hold, and still no duplicates.
    expect(tpOf(one('TClass', 'class'))).toEqual(['T']);
    expect(tpOf(one('TStruct', 'struct'))).toEqual(['Key', 'N', 'Args', 'U', 'Container']);
    expect(tpOf(one('identfn', 'function'))).toEqual(['T']);
    expect(tpOf(one('TAlias', 'type_alias'))).toEqual(['T']);
    expect(tpOf(one('inline_mtemp', 'method'))).toEqual(['U']);
    expect(tpOf(oneDefinition('mtemp', 'method'))).toEqual(['T', 'U']);
    expect(tpOf(one('plain', 'method'))).toBeUndefined();
    expect(tpOf(one('PlainStruct', 'struct'))).toBeUndefined();

    const rows = db().prepare('SELECT name, kind, type_parameters FROM nodes').all() as any[];
    for (const r of rows) {
      const tp = r.type_parameters ? (JSON.parse(r.type_parameters) as string[]) : undefined;
      if (!tp) continue;
      expect(new Set(tp).size, `${r.kind} '${r.name}' typeParameters must be unique after sync`).toBe(tp.length);
    }
  });
});
