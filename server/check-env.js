#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const checks = [
  { name: 'Node.js', command: 'node', args: ['--version'], required: true },
  { name: 'yt-dlp', command: 'yt-dlp', args: ['--version'], required: true },
  { name: 'FFmpeg', command: 'ffmpeg', args: ['-version'], required: true }
];

let failed = false;

for (const check of checks) {
  const result = spawnSync(check.command, check.args, { encoding: 'utf8' });
  if (result.status === 0) {
    const firstLine = `${result.stdout || result.stderr}`.split('\n')[0].trim();
    console.log(`OK  ${check.name}${firstLine ? `: ${firstLine}` : ''}`);
  } else {
    failed = true;
    console.error(`Missing ${check.name}.`);
  }
}

if (failed) {
  console.error('');
  console.error('Install missing tools on Mac with: ./scripts/install-mac-tools.sh');
  process.exit(1);
}
