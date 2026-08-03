import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(repositoryRoot, 'extension', 'backend');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(resolve(repositoryRoot, 'backend', 'src'), resolve(target, 'src'), { recursive: true });
await cp(resolve(repositoryRoot, 'backend', 'dictionaries'), resolve(target, 'dictionaries'), { recursive: true });
await cp(resolve(repositoryRoot, 'backend', 'web-dist'), resolve(target, 'web-dist'), { recursive: true });

process.stdout.write('Prepared extension/backend from the canonical backend and web build.\n');
