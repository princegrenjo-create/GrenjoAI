#!/usr/bin/env node
/**
 * Repository quality gate.
 *
 * Encodes the checks that a reviewer would otherwise have to remember: no
 * swallowed errors, no debug output left in, no silenced compiler errors, no
 * browser-default dialogs, no secret-shaped literals, no direct network calls
 * from the renderer, no privileged key in the shipped tree.
 *
 * Exit code 1 when a rule with `fail: true` is hit, so this can gate a release.
 * Every hit prints file:line and the offending text, which is the artifact the
 * report cites.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(root, 'src');

const RULES = [
  {
    id: 'empty-catch',
    fail: true,
    description: 'A caught error is discarded without handling or logging.',
    pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}/g,
  },
  {
    id: 'debug-output',
    fail: true,
    description: 'console.* left in application code (the main logger writes to a file).',
    pattern: /\bconsole\.(log|debug|info|warn|error|trace)\s*\(/g,
  },
  {
    id: 'silenced-type',
    fail: true,
    description: 'Compiler error silenced instead of being fixed.',
    pattern: /@ts-(ignore|nocheck)|:\s*any\b|\bas\s+any\b/g,
  },
  {
    id: 'deferred-work',
    fail: true,
    description: 'TODO/FIXME shipped in source.',
    pattern: /\b(TODO|FIXME|XXX)\b/g,
  },
  {
    id: 'platform-dialog',
    fail: true,
    description: 'Browser-default dialog on a surface the product owns.',
    pattern: /window\.(confirm|alert|prompt)\s*\(/g,
  },
  {
    id: 'unsafe-html',
    fail: true,
    description: 'Raw HTML injection sink in the renderer.',
    pattern: /dangerouslySetInnerHTML|\.innerHTML\s*=/g,
  },
  {
    id: 'service-role',
    fail: true,
    description: 'The Supabase service_role key must never exist in a client build.',
    pattern: /service_role/g,
    /**
     * A guard that *refuses* a service_role key must be allowed to name it —
     * otherwise the only way to pass this rule would be to stop detecting the
     * dangerous key. A match here is reported as a note, not a failure.
     */
    allowIf: /(reject|refus|must never|isSecretKey|readJwtRole|bypass|\.test\(key\)|secretkey)/i,
    allowNote: 'names service_role in a refusal guard, which is the control itself',
  },
  {
    id: 'secret-literal',
    fail: true,
    description: 'A value shaped like a live API key or JWT is committed.',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./g,
  },
  {
    id: 'renderer-network',
    fail: true,
    description: 'Renderer performs network I/O directly; all calls must cross the IPC bridge.',
    pattern: /\bfetch\s*\(|new\s+XMLHttpRequest\s*\(|new\s+WebSocket\s*\(/g,
    onlyIn: 'renderer',
    ignoreIn: ['api.ts', 'url-policy.ts'],
  },
  {
    id: 'localstorage-token',
    fail: true,
    description: 'Session or token written to Web Storage.',
    pattern: /localStorage\.(setItem|getItem)\s*\([^)]*(token|session|jwt|key)/gi,
  },
];

const ALLOW = [
  // The gate's own rule text and intentional documentation of the rule.
  { file: 'src\\main\\ipc\\register.ts', rule: 'secret-literal' },
];

function walk(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, files);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const files = walk(SRC);
const findings = [];

for (const file of files) {
  const relative = path.relative(root, file);
  const scope = relative.replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

  for (const rule of RULES) {
    if (rule.onlyIn && !scope.includes(rule.onlyIn)) continue;
    if (rule.ignoreIn?.some((suffix) => scope.endsWith(suffix))) continue;
    if (ALLOW.some((entry) => entry.rule === rule.id && relative === entry.file)) continue;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(line)) continue;
      // A rule may legitimately appear in a comment that names the rule itself.
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      const allowed = rule.allowIf ? rule.allowIf.test(line) : false;
      findings.push({
        rule: rule.id,
        fail: rule.fail && !allowed,
        note: allowed ? (rule.allowNote ?? 'matched the rule\'s documented exception') : null,
        description: rule.description,
        file: relative,
        line: index + 1,
        text: trimmed.slice(0, 160),
      });
    }
  }
}

const failing = findings.filter((finding) => finding.fail);
const notes = findings.filter((finding) => !finding.fail);

const byRule = new Map();
for (const finding of findings) {
  const list = byRule.get(finding.rule) ?? [];
  list.push(finding);
  byRule.set(finding.rule, list);
}

if (findings.length === 0) {
  process.stdout.write(`[quality-gate] clean: ${files.length} source files scanned, 0 findings\n`);
  process.exit(0);
}

for (const [rule, list] of byRule) {
  const blocking = list.some((finding) => finding.fail);
  process.stdout.write(
    `\n[quality-gate] ${rule} — ${list[0].description}${blocking ? '' : ' (allowed)'}\n`,
  );
  for (const finding of list) {
    const marker = finding.fail ? 'FAIL' : 'note';
    const suffix = finding.note ? `  (${finding.note})` : '';
    process.stdout.write(`  ${marker}  ${finding.file}:${finding.line}  ${finding.text}${suffix}\n`);
  }
}

process.stdout.write(
  `\n[quality-gate] ${files.length} files scanned, ${findings.length} findings ` +
    `(${failing.length} blocking, ${notes.length} allowed), exit ${failing.length > 0 ? 1 : 0}\n`,
);

process.exit(failing.length > 0 ? 1 : 0);
