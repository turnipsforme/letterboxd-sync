import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const files = ['main.js', 'manifest.json', 'styles.css'];
const distDir = resolve(root, 'dist');

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

for (const file of files) {
  const source = resolve(root, file);
  const target = resolve(distDir, file);
  if (existsSync(source)) {
    copyFileSync(source, target);
  }
}
