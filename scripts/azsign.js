// azsign.js -- electron-builder custom sign hook (win.signtoolOptions.sign).
// Signs every Windows binary electron-builder produces (Cadence.exe, the NSIS
// installer and uninstaller) with Azure Artifact Signing: account dvlce-signing,
// profile dvlce-public, publisher "Yuval Olsha". Auth is the logged-in az CLI.
// The helper azsign.cmd (signtool + Artifact Signing dlib) lives outside the repo;
// set AZSIGN to its path, or CADENCE_NOSIGN=1 to build unsigned.
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const DEFAULT_AZSIGN = 'G:\\dev-tools\\artifact-signing-client\\azsign.cmd';

exports.default = async function sign(configuration) {
  if (process.env.CADENCE_NOSIGN === '1') return;
  // signingHashAlgorithms is ["sha256"], so this runs once per file.
  if (configuration.hash && configuration.hash !== 'sha256') return;
  const azsign = process.env.AZSIGN || DEFAULT_AZSIGN;
  if (!fs.existsSync(azsign)) {
    throw new Error(`azsign helper not found at ${azsign}. Set AZSIGN, or CADENCE_NOSIGN=1 to build unsigned.`);
  }
  execFileSync('cmd.exe', ['/d', '/c', azsign, configuration.path], { stdio: 'inherit' });
};
