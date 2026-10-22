// -----------------------------------------------------------------------------
// The texts read by Gladys, the store and people are clean UTF-8: no BOM, no
// mojibake (a file written through a wrong code page), no control byte; and
// nothing says the password is encrypted (a `secret` field is kept in clear
// in the database of Gladys). The cover is a PNG of the store size.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const sources = (dir) =>
  readdirSync(new URL(dir, root), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.js') || name.endsWith('.mjs'))
    .map((name) => `${dir}${name.replaceAll('\\', '/')}`);

const DOCS = [
  'gladys-assistant-integration.json',
  'docs/fr.md',
  'docs/en.md',
  'README.md',
  'CHANGELOG.md',
  'TODO.md',
  'CLAUDE.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
];
const FILES = [
  ...DOCS,
  'index.js',
  'Dockerfile',
  'package.json',
  ...sources('src/'),
  ...sources('scripts/'),
  // This file spells mojibake on purpose.
  ...sources('test/').filter((f) => f !== 'test/encoding.test.js'),
];

// "Ã", "Â", the "â€" family and "Å’" / "Å“" (Œ / œ read as Windows-1252).
const MOJIBAKE = /Ã|Â|â€|Å[’“]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ENCRYPTED = /chiffr|encrypt/i;

test('the patterns catch what they should', () => {
  for (const word of ['Ã©tÃ©', 'Ã‰tÃ©', 'Ã€ jour', 'â€™', 'â€”', 'Å“uvre', 'Â«']) {
    assert.ok(MOJIBAKE.test(word), word);
  }
  for (const word of ['été', 'Été', 'À jour', 'Ça', 'l’heure', 'œuvre', '« — »', '…', '800×534']) {
    assert.ok(!MOJIBAKE.test(word), word);
  }
  assert.match('stocké chiffré', ENCRYPTED);
  assert.match('stored encrypted', ENCRYPTED);
  assert.match('a\u0007b', CONTROL);
  assert.doesNotMatch('a\tb', CONTROL);
});

test('the source files are part of the check', () => {
  assert.ok(FILES.includes('src/i18n.js'));
  assert.ok(FILES.includes('src/paj/client.js'));
});

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake, no control byte`, () => {
    const bytes = readFileSync(new URL(file, root));
    assert.ok(
      !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
      `${file} starts with a BOM`,
    );
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), `${file} has invalid UTF-8`);
    const lines = text.split('\n');
    const bad = lines.findIndex((l) => MOJIBAKE.test(l));
    assert.equal(bad, -1, `${file}: mojibake on line ${bad + 1}`);
    const control = lines.findIndex((l) => CONTROL.test(l.replace(/\r$/, '')));
    assert.equal(control, -1, `${file}: control byte on line ${control + 1}`);
  });
}

for (const file of [...DOCS.filter((f) => f !== 'CLAUDE.md' && f !== 'TODO.md'), 'src/i18n.js']) {
  test(`${file}: never says the password is encrypted`, () => {
    const text = readFileSync(new URL(file, root), 'utf8');
    const line = text.split('\n').findIndex((l) => ENCRYPTED.test(l));
    assert.equal(line, -1, `"encrypted" on line ${line + 1}`);
  });
}

test('the cover is a PNG of 800 × 534', () => {
  const png = readFileSync(new URL('cover.png', root));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});
