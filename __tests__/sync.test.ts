/**
 * Sync Module Tests
 *
 * Tests for sync functionality (incremental updates).
 * Note: Git hooks functionality has been removed in favor of codegraph's
 * Claude Code hooks integration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';

describe('Sync Module', () => {
  describe('Sync Functionality', () => {
    let testDir: string;
    let cg: CodeGraph;

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sync-func-'));

      // Create initial source files
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      // Initialize and index
      cg = CodeGraph.initSync(testDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) {
        cg.destroy();
      }
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    describe('getChangedFiles()', () => {
      it('should detect added files', () => {
        // Add a new file
        fs.writeFileSync(
          path.join(testDir, 'src', 'new.ts'),
          `export function newFunc() { return 42; }`
        );

        const changes = cg.getChangedFiles();

        expect(changes.added).toContain('src/new.ts');
        expect(changes.modified).toHaveLength(0);
        expect(changes.removed).toHaveLength(0);
      });

      it('should detect modified files', () => {
        // Modify existing file
        fs.writeFileSync(
          path.join(testDir, 'src', 'index.ts'),
          `export function hello() { return 'modified'; }`
        );

        const changes = cg.getChangedFiles();

        expect(changes.added).toHaveLength(0);
        expect(changes.modified).toContain('src/index.ts');
        expect(changes.removed).toHaveLength(0);
      });

      it('should detect removed files', () => {
        // Remove file
        fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

        const changes = cg.getChangedFiles();

        expect(changes.added).toHaveLength(0);
        expect(changes.modified).toHaveLength(0);
        expect(changes.removed).toContain('src/index.ts');
      });
    });

    describe('sync()', () => {
      it('should reindex added files', async () => {
        // Add a new file
        fs.writeFileSync(
          path.join(testDir, 'src', 'new.ts'),
          `export function newFunc() { return 42; }`
        );

        const result = await cg.sync();

        expect(result.filesAdded).toBe(1);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);

        // Verify new function is in the graph
        const nodes = cg.searchNodes('newFunc');
        expect(nodes.length).toBeGreaterThan(0);
      });

      it('should reindex modified files', async () => {
        // Modify existing file
        fs.writeFileSync(
          path.join(testDir, 'src', 'index.ts'),
          `export function goodbye() { return 'farewell'; }`
        );

        const result = await cg.sync();

        expect(result.filesModified).toBe(1);

        // Verify new function is in the graph
        const nodes = cg.searchNodes('goodbye');
        expect(nodes.length).toBeGreaterThan(0);

        // Verify old function is gone
        const oldNodes = cg.searchNodes('hello');
        expect(oldNodes.length).toBe(0);
      });

      it('should remove nodes from deleted files', async () => {
        // Remove file
        fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

        const result = await cg.sync();

        expect(result.filesRemoved).toBe(1);

        // Verify function is gone
        const nodes = cg.searchNodes('hello');
        expect(nodes.length).toBe(0);
      });

      it('should report no changes when nothing changed', async () => {
        const result = await cg.sync();

        expect(result.filesAdded).toBe(0);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);
        expect(result.filesChecked).toBeGreaterThan(0);
      });
    });
  });

  describe('Git-based sync', () => {
    let testDir: string;
    let cg: CodeGraph;

    function git(...args: string[]) {
      execFileSync('git', args, { cwd: testDir, stdio: 'pipe' });
    }

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-git-sync-'));

      // Initialize a git repo with an initial commit
      git('init');
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test');

      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      git('add', '-A');
      git('commit', '-m', 'initial');

      // Initialize CodeGraph and index
      cg = CodeGraph.initSync(testDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) {
        cg.destroy();
      }
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should detect modified files via git', async () => {
      fs.writeFileSync(
        path.join(testDir, 'src', 'index.ts'),
        `export function hello() { return 'modified'; }`
      );

      const result = await cg.sync();

      expect(result.filesModified).toBe(1);
      expect(result.changedFilePaths).toContain('src/index.ts');
    });

    it('should detect new untracked files via git', async () => {
      fs.writeFileSync(
        path.join(testDir, 'src', 'new.ts'),
        `export function newFunc() { return 42; }`
      );

      const result = await cg.sync();

      expect(result.filesAdded).toBe(1);
      expect(result.changedFilePaths).toContain('src/new.ts');

      // Verify the function was indexed
      const nodes = cg.searchNodes('newFunc');
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('should stop reporting untracked files once they are indexed (issue #206)', async () => {
      // Untracked files stay `??` in git status even after codegraph indexes
      // them. Change detection must compare them against the DB by hash, not
      // report every untracked file as "added" on every sync/status.
      fs.writeFileSync(
        path.join(testDir, 'src', 'new.ts'),
        `export function newFunc() { return 42; }`
      );

      // First sync indexes the untracked file.
      const first = await cg.sync();
      expect(first.filesAdded).toBe(1);

      // The file is still untracked in git, but now lives in the DB.
      expect(cg.searchNodes('newFunc').length).toBeGreaterThan(0);

      // status must not keep flagging it as a pending addition...
      const changes = cg.getChangedFiles();
      expect(changes.added).not.toContain('src/new.ts');
      expect(changes.modified).not.toContain('src/new.ts');

      // ...and a second sync must be a no-op for it.
      const second = await cg.sync();
      expect(second.filesAdded).toBe(0);
      expect(second.filesModified).toBe(0);
    });

    it('should re-index an untracked file when its contents change', async () => {
      const filePath = path.join(testDir, 'src', 'new.ts');
      fs.writeFileSync(filePath, `export function newFunc() { return 42; }`);
      await cg.sync();

      // Modify the still-untracked file.
      fs.writeFileSync(filePath, `export function renamedFunc() { return 7; }`);

      const changes = cg.getChangedFiles();
      expect(changes.modified).toContain('src/new.ts');

      const result = await cg.sync();
      expect(result.filesModified).toBe(1);
      expect(cg.searchNodes('renamedFunc').length).toBeGreaterThan(0);
      expect(cg.searchNodes('newFunc').length).toBe(0);
    });

    it('should detect deleted files via git', async () => {
      fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

      const result = await cg.sync();

      expect(result.filesRemoved).toBe(1);

      // Verify function is gone
      const nodes = cg.searchNodes('hello');
      expect(nodes.length).toBe(0);
    });

    it('should skip files with unsupported extensions', async () => {
      // A .txt file has no supported grammar, so sync must not index it.
      fs.writeFileSync(
        path.join(testDir, 'src', 'notes.txt'),
        `just some notes`
      );

      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
    });

    it('should report no changes on clean working tree', async () => {
      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
      expect(result.filesRemoved).toBe(0);
      expect(result.changedFilePaths).toBeUndefined();
    });
  });

  describe('C/C++ sync preserves cross-file references', () => {
    let testDir: string;
    let cg: CodeGraph;

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sync-cpp-'));
    });

    afterEach(async () => {
      if (cg) await cg.close();
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('preserves cross-file callers after definition file is modified', async () => {
      // Setup: a.h (extern decl), a.c (definition + same-file caller), b.c (cross-file caller)
      fs.writeFileSync(path.join(testDir, 'a.h'), 'extern int g_counter;');
      fs.writeFileSync(path.join(testDir, 'a.c'),
        '#include "a.h"\nint g_counter = 0;\nint get(void) { return g_counter; }');
      fs.writeFileSync(path.join(testDir, 'b.c'),
        '#include "a.h"\nint read(void) { return g_counter; }');

      cg = await CodeGraph.init(testDir);
      await cg.indexAll();

      // Verify initial callers. The header's `extern` decl is also a variable
      // node (isDeclaration=true); references resolve to the definition, so
      // query the definition node for callers.
      const varNode1 = (await cg.searchNodes('g_counter', { limit: 10 }))
        .find(r => r.node.kind === 'variable' && !r.node.isDeclaration);
      expect(varNode1).toBeDefined();
      const callers1 = await cg.getCallers(varNode1!.node.id);
      const callerNames1 = callers1.map(c => c.node.name);
      expect(callerNames1).toContain('get');
      expect(callerNames1).toContain('read');

      // Modify a.c (change g_counter initializer)
      const now = new Date();
      const acPath = path.join(testDir, 'a.c');
      let content = fs.readFileSync(acPath, 'utf8');
      content = content.replace('int g_counter = 0', 'int g_counter = 1');
      fs.writeFileSync(acPath, content);
      fs.utimesSync(acPath, now, now);

      // Sync re-indexes a.c. b.c's cross-file edges to a.c's nodes are
      // preserved via edge re-wiring (no co-importer re-indexing needed).
      const result = await cg.sync();
      expect(result.filesModified).toBeGreaterThanOrEqual(1);

      // Verify cross-file caller is still present after sync
      const varNode2 = (await cg.searchNodes('g_counter', { limit: 10 }))
        .find(r => r.node.kind === 'variable' && !r.node.isDeclaration);
      expect(varNode2).toBeDefined();
      const callers2 = await cg.getCallers(varNode2!.node.id);
      const callerNames2 = callers2.map(c => c.node.name);
      expect(callerNames2).toContain('get');
      expect(callerNames2).toContain('read');
    });

    it('preserves cross-file callers when only the header is modified', async () => {
      fs.writeFileSync(path.join(testDir, 'a.h'), 'extern int g_counter;');
      fs.writeFileSync(path.join(testDir, 'a.c'),
        '#include "a.h"\nint g_counter = 0;');
      fs.writeFileSync(path.join(testDir, 'b.c'),
        '#include "a.h"\nint read(void) { return g_counter; }');

      cg = await CodeGraph.init(testDir);
      await cg.indexAll();

      const varNode1 = (await cg.searchNodes('g_counter', { limit: 10 }))
        .find(r => r.node.kind === 'variable' && !r.node.isDeclaration);
      const callers1 = await cg.getCallers(varNode1!.node.id);
      expect(callers1.map(c => c.node.name)).toContain('read');

      // Modify a.h (add a new extern declaration)
      const now = new Date();
      const ahPath = path.join(testDir, 'a.h');
      fs.writeFileSync(ahPath, 'extern int g_counter;\nextern int g_other;');
      fs.utimesSync(ahPath, now, now);

      const result = await cg.sync();
      expect(result.filesModified).toBeGreaterThanOrEqual(1);

      const varNode2 = (await cg.searchNodes('g_counter', { limit: 10 }))
        .find(r => r.node.kind === 'variable' && !r.node.isDeclaration);
      const callers2 = await cg.getCallers(varNode2!.node.id);
      expect(callers2.map(c => c.node.name)).toContain('read');
    });

    it('does not lose function call edges after sync', async () => {
      // a.c defines foo(), b.c calls foo() via #include "a.h"
      fs.writeFileSync(path.join(testDir, 'a.h'), 'void foo(void);');
      fs.writeFileSync(path.join(testDir, 'a.c'),
        '#include "a.h"\nvoid foo(void) {}');
      fs.writeFileSync(path.join(testDir, 'b.c'),
        '#include "a.h"\nvoid caller(void) { foo(); }');

      cg = await CodeGraph.init(testDir);
      await cg.indexAll();

      const fooNode = (await cg.searchNodes('foo', { limit: 10 }))
        .find(r => r.node.kind === 'function' && r.node.name === 'foo');
      const callers1 = await cg.getCallers(fooNode!.node.id);
      expect(callers1.map(c => c.node.name)).toContain('caller');

      // Modify a.c
      const now = new Date();
      const acPath = path.join(testDir, 'a.c');
      fs.writeFileSync(acPath, '#include "a.h"\nvoid foo(void) { /* updated */ }');
      fs.utimesSync(acPath, now, now);

      await cg.sync();

      const fooNode2 = (await cg.searchNodes('foo', { limit: 10 }))
        .find(r => r.node.kind === 'function' && r.node.name === 'foo');
      const callers2 = await cg.getCallers(fooNode2!.node.id);
      expect(callers2.map(c => c.node.name)).toContain('caller');
    });

    it('orders equal-score definitions before declarations deterministically after sync', async () => {
      fs.writeFileSync(path.join(testDir, 'a.h'), 'void stable_target(void);');
      fs.writeFileSync(path.join(testDir, 'a.c'),
        '#include "a.h"\nvoid stable_target(void) {}');

      cg = await CodeGraph.init(testDir);
      await cg.indexAll();

      const searchTarget = (exact: boolean) =>
        cg.searchNodes('stable_target', { exact, limit: 10 })
          .filter(r => r.node.kind === 'function' && r.node.name === 'stable_target');

      const expectDefinitionFirstAndStable = (exact: boolean) => {
        const first = searchTarget(exact);
        expect(first).toHaveLength(2);
        expect(first.map(r => ({
          filePath: r.node.filePath,
          isDeclaration: r.node.isDeclaration,
        }))).toEqual([
          { filePath: 'a.c', isDeclaration: false },
          { filePath: 'a.h', isDeclaration: true },
        ]);

        const expectedIds = first.map(r => r.node.id);
        for (let i = 0; i < 3; i++) {
          expect(searchTarget(exact).map(r => r.node.id)).toEqual(expectedIds);
        }
      };

      expectDefinitionFirstAndStable(false);
      expectDefinitionFirstAndStable(true);

      const acPath = path.join(testDir, 'a.c');
      fs.writeFileSync(acPath,
        '#include "a.h"\nvoid stable_target(void) { /* updated */ }');
      const now = new Date();
      fs.utimesSync(acPath, now, now);
      await cg.sync();

      expectDefinitionFirstAndStable(false);
      expectDefinitionFirstAndStable(true);
    });
  });
});
