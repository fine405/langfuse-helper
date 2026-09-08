import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'dist');
await mkdir(directory, { recursive: true });
const result = spawnSync('npm', ['pack', '--json', '--pack-destination', directory], { cwd: root, encoding: 'utf8' });
if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'npm pack failed');
const [{ filename }] = JSON.parse(result.stdout);
const output = join(directory, filename);
const digest = createHash('sha256').update(await readFile(output)).digest('hex');
await writeFile(`${output}.sha256`, `${digest}  ${filename}\n`);
console.log(`Package: ${output}\nSHA-256: ${digest}`);
