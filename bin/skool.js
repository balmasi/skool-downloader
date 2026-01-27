#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const tsxBin = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
);

const entry = path.join(projectRoot, 'src', 'cli.ts');
const args = process.argv.slice(2);

const child = spawn(tsxBin, [entry, ...args], {
    stdio: 'inherit'
});

child.on('exit', (code) => {
    process.exit(code ?? 0);
});
