import { loadSchema, validate } from './schema.ts';
import type { CheckError, ConfigScope, FileFact, Plan, Scope } from './types.ts';

interface Caps { configScopes: ConfigScope[]; maxFiles: number; maxLines: number }

export function checkPlan(plan: unknown, opts: Caps & { facts: FileFact[] }): CheckError[] {
  const schemaErrors = validate(loadSchema('plan'), plan);
  if (schemaErrors.length > 0) return schemaErrors;

  const { scopes } = plan as Plan;
  const facts = new Map(reviewable(opts.facts).map((f) => [f.path, f]));
  const errors: CheckError[] = [];
  const placed = new Map<string, number>();

  for (const scope of scopes) {
    for (const path of scope.files) {
      placed.set(path, (placed.get(path) ?? 0) + 1);
      if (!facts.has(path)) {
        errors.push({ code: 'plan.unknown', message: `${path} (scope "${scope.name}") is not a reviewable file in this PR`, path });
        continue;
      }
      const owner = configScopeFor(path, opts.configScopes);
      if (owner && !belongsTo(scope.name, owner.name)) {
        errors.push({ code: 'plan.config_scope', message: `${path} matches config scope "${owner.name}" but is in scope "${scope.name}"`, path });
      }
    }
    if (scope.files.length > opts.maxFiles) {
      errors.push({ code: 'plan.too_many_files', message: `scope "${scope.name}" has ${scope.files.length} files (max ${opts.maxFiles})` });
    }
    const lines = scope.files.reduce((sum, path) => sum + lineCount(facts.get(path)), 0);
    // A single file cannot be split further, so it may exceed the line cap on its own.
    if (scope.files.length > 1 && lines > opts.maxLines) {
      errors.push({ code: 'plan.too_many_lines', message: `scope "${scope.name}" has ${lines} changed lines (max ${opts.maxLines})` });
    }
  }

  for (const [path, count] of placed) {
    if (count > 1 && facts.has(path)) errors.push({ code: 'plan.duplicate', message: `${path} appears in ${count} scopes`, path });
  }
  for (const path of facts.keys()) {
    if (!placed.has(path)) errors.push({ code: 'plan.missing', message: `${path} is not in any scope`, path });
  }
  return errors;
}

export function fallbackPlan(facts: FileFact[], opts: Caps): Plan {
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

  const scopes: Scope[] = [];
  for (const [name, group] of groups) {
    const chunks = chunk(group.files, opts);
    chunks.forEach((files, i) => {
      scopes.push({
        name: chunks.length > 1 ? `${name} (${i + 1})` : name,
        files: files.map((f) => f.path),
        focus: group.focus,
        context: group.context,
      });
    });
  }
  return { scopes };
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
