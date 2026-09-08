import { cp, mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { projectRoot } from './settings.mjs';
import { releaseFiles } from './install.mjs';

const version = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).version;
const name = `workbuddy-langfuse-${version}-macos`;
const staging = await mkdtemp(join(tmpdir(), 'wb-lf-package-'));
const output = join(projectRoot, 'dist', `${name}.zip`);
try {
  const directory = join(staging, name); await mkdir(directory);
  for (const file of releaseFiles) await cp(join(projectRoot, file), join(directory, file), { recursive: true });
  await mkdir(join(projectRoot, 'dist'), { recursive: true });
  const result = spawnSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', directory, output], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('安装包生成失败');
  const digest = createHash('sha256').update(await readFile(output)).digest('hex');
  await writeFile(`${output}.sha256`, `${digest}  ${name}.zip\n`);
  console.log(`安装包：${output}\nSHA-256：${digest}`);
} finally { await rm(staging, { recursive: true, force: true }); }
