import { loadSchema, validate } from './schema.ts';
import type { CheckError, ConfigScope, FileFact, Plan, Scope } from './types.ts';

interface Caps { configScopes: ConfigScope[]; maxFiles: number; maxLines: number }

export function checkPlan(plan: unknown, opts: Caps & { facts: FileFact[] }): CheckError[] {
  const schemaErrors = validate(loadSchema('plan'), plan);
  if (schemaErrors.length > 0) return schemaErrors;

  const { scopes } = plan as Plan;
  const facts = new Map(reviewable(opts.facts).map((f) => [f.path, f]));
  // A deleted file is part of the PR, and reviewing it beside its replacement helps, so a scope may carry it.
  const deleted = new Set(opts.facts.filter((f) => f.status === 'deleted').map((f) => f.path));
  const errors: CheckError[] = [];
  const placed = new Map<string, string[]>();

  for (const scope of scopes) {
    for (const path of scope.files) {
      if (deleted.has(path)) continue;
      placed.set(path, [...(placed.get(path) ?? []), scope.name]);
      if (!facts.has(path)) {
        errors.push({ code: 'plan.unknown', message: `${path} (scope "${scope.name}") is not a reviewable file in this PR: remove it`, path });
        continue;
      }
      const owner = configScopeFor(path, opts.configScopes);
      if (owner && !belongsTo(scope.name, owner.name)) {
        const home = `move it to a scope named exactly "${owner.name}" (or "${owner.name} (1)", "${owner.name} (2)", … if you split that scope)`;
        errors.push({ code: 'plan.config_scope', message: `${path} matches config scope "${owner.name}" but is in scope "${scope.name}": ${home}`, path });
      }
    }
    if (scope.files.length > opts.maxFiles) {
      errors.push({ code: 'plan.too_many_files', message: `scope "${scope.name}" has ${scope.files.length} files (max ${opts.maxFiles}): ${splitHint(scope, facts, opts)}` });
    }
    const lines = scope.files.reduce((sum, path) => sum + lineCount(facts.get(path)), 0);
    // A single file cannot be split further, so it may exceed the line cap on its own.
    if (scope.files.length > 1 && lines > opts.maxLines) {
      errors.push({ code: 'plan.too_many_lines', message: `scope "${scope.name}" has ${lines} changed lines (max ${opts.maxLines}): ${splitHint(scope, facts, opts)}` });
    }
  }

  for (const [path, names] of placed) {
    if (names.length > 1 && facts.has(path)) {
      errors.push({ code: 'plan.duplicate', message: `${path} appears in scopes ${names.map((n) => `"${n}"`).join(', ')}: keep it in one`, path });
    }
  }
  for (const path of facts.keys()) {
    if (!placed.has(path)) errors.push({ code: 'plan.missing', message: `${path} is not in any scope: add it to exactly one`, path });
  }
  return errors;
}

function splitHint(scope: Scope, facts: Map<string, FileFact>, caps: Caps): string {
  const known = scope.files.flatMap((path) => facts.get(path) ?? []);
  const parts = splitScope(scope, known, caps).map((part) => `"${part.name}": [${part.files.join(', ')}]`);
  return `split it, e.g. into ${parts.join(' and ')}`;
}

/**
 * Used once the lead has run out of attempts. It keeps the lead's last plan — its grouping, focus and
 * context — and only repairs what breaks a rule; files it cannot place are grouped by directory.
 */
export function fallbackPlan(facts: FileFact[], opts: Caps, draft?: unknown): Plan {
  const repaired = repairScopes(draft, facts, opts);
  const placed = new Set(repaired.flatMap((scope) => scope.files));
  return { scopes: [...repaired, ...directoryPlan(facts.filter((f) => !placed.has(f.path)), opts).scopes] };
}

// Drops unknown and repeated paths, sends a misplaced config-scope file to the lead's scope of that name, and splits oversize scopes.
function repairScopes(draft: unknown, facts: FileFact[], opts: Caps): Scope[] {
  if (validate(loadSchema('plan'), draft).length > 0) return [];
  const known = new Map(facts.map((f) => [f.path, f]));
  const scopes = (draft as Plan).scopes.map((scope) => ({ scope, facts: [] as FileFact[] }));
  const placed = new Set<string>();
  for (const { scope, facts: kept } of scopes) {
    for (const path of scope.files) {
      const fact = known.get(path);
      if (!fact || placed.has(path)) continue;
      const owner = configScopeFor(path, opts.configScopes);
      const home = owner && !belongsTo(scope.name, owner.name) ? scopes.find((s) => s.scope.name === owner.name)?.facts : kept;
      if (!home) continue;
      placed.add(path);
      home.push(fact);
    }
  }
  return scopes.flatMap(({ scope, facts: kept }) => splitScope(scope, kept, opts));
}

function directoryPlan(facts: FileFact[], opts: Caps): Plan {
  const groups = new Map<string, { focus: string; context: string[]; files: FileFact[] }>();
  const groupFor = (name: string, config?: ConfigScope) => {
    let group = groups.get(name);
    if (!group) {
      group = { focus: config?.focus ?? `General review of ${name}`, context: config?.context ?? [], files: [] };
      groups.set(name, group);
    }
    return group;
  };

  for (const scope of opts.configScopes) groupFor(scope.name, scope);
  const sorted = reviewable(facts).sort((a, b) => a.path.localeCompare(b.path));
  const byDir = new Map<string, FileFact[]>();
  for (const fact of sorted) {
    const owner = configScopeFor(fact.path, opts.configScopes);
    if (owner) {
      groupFor(owner.name).files.push(fact);
      continue;
    }
    const dir = fact.dir || 'root';
    byDir.set(dir, [...(byDir.get(dir) ?? []), fact]);
  }
  for (const dir of [...byDir.keys()].sort()) groupFor(dir).files.push(...byDir.get(dir)!);

  return { scopes: [...groups].flatMap(([name, group]) => splitScope({ name, files: [], focus: group.focus, context: group.context }, group.files, opts)) };
}

// Parts are named "name (1)", "name (2)", …, which `belongsTo` still counts as the config scope `name`.
function splitScope(scope: Scope, files: FileFact[], caps: Caps): Scope[] {
  const chunks = chunk(files, caps);
  return chunks.map((part, i) => ({
    name: chunks.length > 1 ? `${scope.name} (${i + 1})` : scope.name,
    files: part.map((f) => f.path),
    focus: scope.focus,
    context: scope.context,
  }));
}

export function matchGlob(pattern: string, path: string): boolean {
  return new RegExp(`^${globToRegex(pattern)}$`).test(path);
}

function globToRegex(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] !== '*') {
        out += '[^/]*';
      } else if (pattern[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{' && pattern.indexOf('}', i) > i) {
      const close = pattern.indexOf('}', i);
      out += `(?:${pattern.slice(i + 1, close).split(',').map(globToRegex).join('|')})`;
      i = close;
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

function reviewable(facts: FileFact[]): FileFact[] {
  return facts.filter((f) => f.status !== 'deleted');
}

function lineCount(fact: FileFact | undefined): number {
  return fact ? fact.added + fact.removed : 0;
}

function configScopeFor(path: string, configScopes: ConfigScope[]): ConfigScope | undefined {
  return configScopes.find((scope) => scope.paths.some((pattern) => matchGlob(pattern, path)));
}

// Fallback splits an oversize config scope into "name (1)", "name (2)", …; those parts still belong to it.
function belongsTo(scopeName: string, configName: string): boolean {
  if (scopeName === configName) return true;
  const prefix = `${configName} (`;
  return scopeName.startsWith(prefix) && /^\d+\)$/.test(scopeName.slice(prefix.length));
}

function chunk(files: FileFact[], caps: Caps): FileFact[][] {
  const chunks: FileFact[][] = [];
  let current: FileFact[] = [];
  let lines = 0;
  for (const fact of files) {
    const size = lineCount(fact);
    if (current.length > 0 && (current.length >= caps.maxFiles || lines + size > caps.maxLines)) {
      chunks.push(current);
      current = [];
      lines = 0;
    }
    current.push(fact);
    lines += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
