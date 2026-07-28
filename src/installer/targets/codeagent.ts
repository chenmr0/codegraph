/**
 * CodeAgent 3.0 target.
 *
 * CodeAgent 3.0 is a Claude Code fork (`(cc)` in the prompt label), so its
 * config layout mirrors Claude Code's exactly — only the directory and
 * file names change. Writes:
 *
 *   - MCP server entry to `~/.cac.json` (global = user scope, loads in
 *     every project) or `./.mcp.json` (local = project scope). Same
 *     `mcpServers.codegraph` shape as Claude Code. CodeAgent reads its
 *     user-scope MCP servers from `~/.cac.json` (BRAND_CAC.GLOBAL_CONFIG_FILE)
 *     and project-scope from `./.mcp.json` (getProjectMcpFilePathCac →
 *     git root + '.mcp.json').
 *   - Permissions to `~/.cac/settings.json` (global) or
 *     `./.cac/settings.json` (local), gated on `autoAllow`. Same
 *     `mcp__codegraph__*` allowlist format Claude Code uses.
 *   - Instructions to `~/.cac/AGENTS.md` (global) or `./AGENTS.md`
 *     (local — CodeAgent reads the project-root AGENTS.md directly, not
 *     under `.cac/`, matching its getMemoryPath('Project') / ('User')
 *     resolution).
 *
 * No legacy `./.claude.json` migration and no pre-0.8 hook cleanup apply
 * here — CodeAgent is a brand-new target, so there's nothing stale to
 * self-heal on that side. The instructions strip is kept for parity so a
 * future upgrade self-heals any block a prior install might write.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  getCodeGraphPermissions,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  writeJsonFile,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.cac')
    : path.join(process.cwd(), '.cac');
}
function mcpJsonPath(loc: Location): string {
  // global → ~/.cac.json (user scope: visible in every project).
  // local  → ./.mcp.json (project scope: the file CodeAgent reads for
  // project-level MCP, resolved from the git root / cwd).
  return loc === 'global'
    ? path.join(os.homedir(), '.cac.json')
    : path.join(process.cwd(), '.mcp.json');
}
function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}
function instructionsPath(loc: Location): string {
  // Global AGENTS.md lives under ~/.cac/; project-local AGENTS.md lives
  // at the project root (NOT under .cac/), matching CodeAgent's
  // hierarchical instructions loader (getMemoryPath).
  return loc === 'global'
    ? path.join(configDir('global'), 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}

class CodeAgentTarget implements AgentTarget {
  readonly id = 'codeagent' as const;
  readonly displayName = 'CodeAgent 3.0 (cc)';
  readonly docsUrl = 'https://docs.codeagent.example.com';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    // Infer "installed" from the existence of either the config dir
    // (global) or the project MCP marker file (local). Cheap and avoids
    // shelling out to `codeagentcli --version`.
    const installed = loc === 'global'
      ? fs.existsSync(configDir(loc)) || fs.existsSync(mcpPath)
      : fs.existsSync(mcpPath) || fs.existsSync(configDir(loc));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
    files.push(writeMcpEntry(loc));

    // 2. Permissions (only when autoAllow)
    if (opts.autoAllow) {
      files.push(writePermissionsEntry(loc));
    }

    // 3. AGENTS.md instructions — no longer written. The codegraph
    // usage guidance ships solely in the MCP server's `initialize`
    // response (issue #529). Strip any block a previous install left
    // behind so an upgrade self-heals — same idiom as the other targets.
    const instrCleanup = removeInstructionsEntry(loc);
    if (instrCleanup.action === 'removed') files.push(instrCleanup);

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    // 2. Permissions
    const settingsPath = settingsJsonPath(loc);
    const settings = readJsonFile(settingsPath);
    if (Array.isArray(settings.permissions?.allow)) {
      const before = settings.permissions.allow.length;
      settings.permissions.allow = settings.permissions.allow.filter(
        (p: string) => !p.startsWith('mcp__codegraph__'),
      );
      if (settings.permissions.allow.length !== before) {
        if (settings.permissions.allow.length === 0) {
          delete settings.permissions.allow;
        }
        if (Object.keys(settings.permissions).length === 0) {
          delete settings.permissions;
        }
        writeJsonFile(settingsPath, settings);
        files.push({ path: settingsPath, action: 'removed' });
      } else {
        files.push({ path: settingsPath, action: 'not-found' });
      }
    } else {
      files.push({ path: settingsPath, action: 'not-found' });
    }

    // 3. Instructions — strip the legacy CodeGraph block if present.
    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), settingsJsonPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    // Already exactly what we'd write — preserve byte-identical file.
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

function writePermissionsEntry(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  const settings = readJsonFile(file);
  const created = !fs.existsSync(file);

  if (!settings.permissions) settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

  const want = getCodeGraphPermissions();
  const before = [...settings.permissions.allow];
  for (const perm of want) {
    if (!settings.permissions.allow.includes(perm)) {
      settings.permissions.allow.push(perm);
    }
  }
  if (jsonDeepEqual(before, settings.permissions.allow) && !created) {
    return { path: file, action: 'unchanged' };
  }
  writeJsonFile(file, settings);
  return { path: file, action: created ? 'created' : 'updated' };
}

/**
 * Strip the marker-delimited CodeGraph block from AGENTS.md if a prior
 * install wrote one. Codegraph no longer maintains an instructions file
 * (issue #529) — the MCP server's `initialize` instructions are the
 * single source of truth — so both install (self-heal on upgrade) and
 * uninstall call this. `removeMarkedSection` returns `not-found`/`kept`
 * when there's nothing to strip; the install caller drops those from
 * the report so a fresh install stays quiet.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const codeagentTarget: AgentTarget = new CodeAgentTarget();