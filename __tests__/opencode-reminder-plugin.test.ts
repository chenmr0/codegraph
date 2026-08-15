import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { OPENCODE_REMINDER_PLUGIN_SOURCE } from '../src/installer/opencode-reminder-plugin';

describe('OpenCode CodeGraph native-tool reminder plugin', () => {
  let dir: string;
  let hook: (input: any, output: any) => Promise<void>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-opencode-reminder-'));
    const pluginFile = path.join(dir, 'codegraph-reminder.mjs');
    fs.writeFileSync(pluginFile, OPENCODE_REMINDER_PLUGIN_SOURCE);
    const pluginModule = await import(`${pathToFileURL(pluginFile).href}?test=${Date.now()}-${Math.random()}`);
    const plugin = await pluginModule.CodeGraphReminderPlugin({ directory: dir, worktree: dir });
    hook = plugin['tool.execute.after'];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing when the current repository is not indexed', async () => {
    const output = { output: 'int main() {}', title: '', metadata: {} };
    await hook({ tool: 'read', sessionID: 's1', args: { filePath: 'main.cpp' } }, output);
    expect(output.output).not.toContain('<system-reminder>');
  });

  it('reminds after indexed source read, but not docs or a repeated same-file read', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph'));
    const first = { output: 'int main() {}', title: '', metadata: {} };
    await hook({ tool: 'read', sessionID: 's1', args: { filePath: 'main.cpp' } }, first);
    expect(first.output).toContain('<system-reminder>');
    expect(first.output).toContain('优先使用 CodeGraph系列工具，而不是read，grep等。');
    expect(first.output).toContain('</system-reminder>');

    const repeated = { output: 'return 0;', title: '', metadata: {} };
    await hook({ tool: 'read', sessionID: 's1', args: { filePath: 'main.cpp', offset: 100 } }, repeated);
    expect(repeated.output).not.toContain('<system-reminder>');

    const docs = { output: '# Guide', title: '', metadata: {} };
    await hook({ tool: 'read', sessionID: 's1', args: { filePath: 'README.md' } }, docs);
    expect(docs.output).not.toContain('<system-reminder>');
  });

  it('recognizes source paths in grep output and re-arms after CodeGraph use', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph'));
    const grep = { output: 'src/channel.cpp:42: get_dfc()', title: '', metadata: {} };
    await hook({ tool: 'grep', sessionID: 's1', args: { path: 'src', pattern: 'get_dfc' } }, grep);
    expect(grep.output).toContain('<system-reminder>');
    expect(grep.output).toContain('优先使用 CodeGraph系列工具');

    await hook({ tool: 'codegraph_search', sessionID: 's1', args: { query: 'get_dfc' } }, { output: 'hit' });
    const nextGrep = { output: 'src/channel.cpp:42: get_dfc()', title: '', metadata: {} };
    await hook({ tool: 'grep', sessionID: 's1', args: { path: 'src', pattern: 'get_dfc' } }, nextGrep);
    expect(nextGrep.output).toContain('<system-reminder>');
  });

  it('does not redirect a read of a file edited in the same session', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph'));
    await hook({ tool: 'edit', sessionID: 's1', args: { filePath: 'main.cpp' } }, { output: 'done' });
    const output = { output: 'new source', title: '', metadata: {} };
    await hook({ tool: 'read', sessionID: 's1', args: { filePath: 'main.cpp' } }, output);
    expect(output.output).not.toContain('<system-reminder>');
  });
});
