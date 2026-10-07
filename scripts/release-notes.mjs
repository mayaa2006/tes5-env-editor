// Prints the CHANGELOG.md section for the given version (used as GitHub release notes).
import { readFileSync } from 'node:fs';

const version = process.argv[2];
const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split('\n');
const start = lines.findIndex((l) => l.startsWith(`## ${version}`));
if (start < 0) {
  console.log('See README.md for what is included.');
} else {
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  console.log(lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim());
}
