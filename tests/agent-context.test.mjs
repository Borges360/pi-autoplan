import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

test('Pi Autoplan specialization is identical for current runtimes', () => {
  const paths = [
    '.agents/skills/pi-autoplan/SKILL.md',
    '.cursor/skills/pi-autoplan/SKILL.md'
  ];
  const skills = paths.map(read);
  const metadata = [
    read('.agents/skills/pi-autoplan/metadata.yaml'),
    read('.cursor/skills/pi-autoplan/metadata.yaml')
  ];
  assert.ok(skills[0].length > 0);
  assert.equal(skills[1], skills[0]);
  assert.equal(metadata[1], metadata[0]);
  assert.match(metadata[0], /id: pi-autoplan/);
  assert.match(metadata[0], /owner: pi-autoplan/);
  assert.match(metadata[0], /product-local; Pi, Codex and Cursor/);
});

test('product context does not turn shared tooling or asset notices into design-system adoption', () => {
  const agents = read('AGENTS.md');
  const marker = agents.indexOf('<!-- harness:start -->');
  assert.ok(marker > 0);
  const preamble = agents.slice(0, marker);
  assert.ok(preamble.includes('.agents/skills/pi-autoplan/SKILL.md'));
  assert.ok(preamble.includes('do not infer one'));
  assert.doesNotMatch(preamble, /INTEIRO/i);
});

test('specialization reflects safe default and user-visible commands', () => {
  const skill = read('.agents/skills/pi-autoplan/SKILL.md');
  const packageJson = JSON.parse(read('package.json'));
  const source = read('src/extension.ts');
  assert.equal(packageJson.name, '@borges360/pi-autoplan');
  assert.match(source, /"pi-autoplan",\s*"plan",[\s\S]*?\[\s*"autoplan"\s*\]/);
  assert.ok(skill.includes('/plan status'));
  assert.ok(skill.includes('/autoplan remains a compatibility alias'));
  for (const rule of ['file storage', 'Default writes are disabled', 'Ctrl+S', 'Escape', 'mandatory sibling-extension dependency']) {
    assert.ok(skill.includes(rule), rule);
  }
});
