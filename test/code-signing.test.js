/* global require, __dirname */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const hookPath = path.join(__dirname, '..', 'scripts', 'azsign.js');
const source = fs.readFileSync(hookPath, 'utf8');
const defaultHelper = 'G:\\dev-tools\\artifact-signing-client\\azsign.cmd';
const customHelper = 'E:\\Signing Tools\\azsign.cmd';

// Each hook has isolated environment and dependencies. No process-wide loader,
// environment or require-cache changes, and no real filesystem checks or signing.
function loadHook({ env = {}, exists = true, failure } = {}) {
  const calls = [];
  const checked = [];
  const exported = {};
  vm.runInNewContext(source, {
    exports: exported,
    module: { exports: exported },
    process: { env },
    require(name) {
      if (name === 'node:fs') {
        return {
          existsSync(file) {
            checked.push(file);
            return exists;
          },
        };
      }
      if (name === 'node:child_process') {
        return {
          execFileSync(command, args, options) {
            calls.push({ command, args: Array.from(args), shell: options?.shell });
            if (failure) throw failure;
          },
        };
      }
      throw new Error('Unexpected hook dependency: ' + name);
    },
  }, { filename: hookPath });
  return { sign: exported.default, calls, checked };
}

function expectInvocation(call, helper, file) {
  assert.equal(call.command, 'cmd.exe');
  assert.deepEqual(call.args, ['/d', '/c', helper, file]);
  assert.ok(call.shell === undefined || call.shell === false, 'must not enable an extra shell');
}

test('default export returns a promise and signs each sha256 or hashless file once', async () => {
  const { sign, calls, checked } = loadHook({ env: { AZSIGN: customHelper } });
  assert.equal(typeof sign, 'function');
  const files = [
    { path: 'E:\\Build Output\\release\\win-unpacked\\Cadence.exe', hash: 'sha256' },
    { path: 'E:\\Build Output\\release\\Cadence Setup.exe' },
    { path: 'E:\\Build Output\\release\\uninstaller.exe', hash: 'sha256' },
  ];
  for (const configuration of files) {
    const result = sign(configuration);
    assert.equal(typeof result?.then, 'function', 'hook must return a promise');
    await result;
  }
  assert.equal(calls.length, files.length);
  files.forEach((file, index) => expectInvocation(calls[index], customHelper, file.path));
  assert.deepEqual(checked, files.map(() => customHelper));
});

for (const hash of ['sha1', 'sha512', 'SHA256']) {
  test('skips unsupported hash ' + hash + ' before checking a missing helper', async () => {
    const { sign, calls, checked } = loadHook({ exists: false });
    await sign({ path: 'release\\Cadence.exe', hash });
    assert.deepEqual(checked, []);
    assert.deepEqual(calls, []);
  });
}

test('CADENCE_NOSIGN=1 skips both hashed and hashless calls with a missing helper', async () => {
  const { sign, calls, checked } = loadHook({
    env: { CADENCE_NOSIGN: '1', AZSIGN: customHelper },
    exists: false,
  });
  await sign({ path: 'release\\Cadence.exe', hash: 'sha256' });
  await sign({ path: 'release\\Cadence Setup.exe' });
  assert.deepEqual(checked, []);
  assert.deepEqual(calls, []);
});

for (const value of ['0', 'true']) {
  test('CADENCE_NOSIGN=' + value + ' does not disable signing', async () => {
    const { sign, calls } = loadHook({ env: { CADENCE_NOSIGN: value } });
    await sign({ path: 'release\\Cadence.exe', hash: 'sha256' });
    assert.equal(calls.length, 1);
    expectInvocation(calls[0], defaultHelper, 'release\\Cadence.exe');
  });
}

for (const [label, env, helper] of [
  ['unset AZSIGN', {}, defaultHelper],
  ['empty AZSIGN', { AZSIGN: '' }, defaultHelper],
  ['AZSIGN override', { AZSIGN: customHelper }, customHelper],
]) {
  test('selects and checks the helper for ' + label, async () => {
    const { sign, calls, checked } = loadHook({ env });
    await sign({ path: 'release\\Cadence.exe', hash: 'sha256' });
    assert.deepEqual(checked, [helper]);
    assert.equal(calls.length, 1);
    expectInvocation(calls[0], helper, 'release\\Cadence.exe');
  });

  test('rejects a missing helper for ' + label + ' without executing or falling back', async () => {
    const { sign, calls, checked } = loadHook({ env, exists: false });
    await assert.rejects(() => sign({ path: 'release\\Cadence.exe', hash: 'sha256' }),
      /azsign helper not found/);
    assert.deepEqual(checked, [helper]);
    assert.deepEqual(calls, []);
  });
}

test('a nonzero helper exit rejects the hook without retrying', async () => {
  const failure = Object.assign(new Error('signing failed'), { status: 7 });
  const { sign, calls } = loadHook({ failure });
  await assert.rejects(() => sign({ path: 'release\\Cadence.exe', hash: 'sha256' }),
    (error) => error === failure);
  assert.equal(calls.length, 1);
});

test('electron-builder uses this hook, SHA256 only, and the exact certificate publisher', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const options = pkg.build.win.signtoolOptions;
  assert.equal(path.resolve(__dirname, '..', options.sign), hookPath);
  assert.deepEqual(options.signingHashAlgorithms, ['sha256']);
  assert.deepEqual(options.publisherName, ['Yuval Olsha']);
});

test('release source gates publication on signature status OR publisher mismatch', () => {
  // Static source contract only: never execute release.ps1. Match the connected
  // guard and its fatal action, not independent fragments that could be dead code.
  const release = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.ps1'), 'utf8')
    .replace(/<#[\s\S]*?#>/g, '')
    .replace(/^\s*#.*$/gm, '');
  const guard = /^\$sig\s*=\s*Get-AuthenticodeSignature\s+\$exe\s*\r?\n\s*if\s*\(\s*\$sig\.Status\s+-ne\s+'Valid'\s+-or\s+\$sig\.SignerCertificate\.Subject\s+-notmatch\s+'\^CN=Yuval Olsha,'\s*\)\s*\{\s*Die\s+"[^"\r\n]*"\s*\}/m.exec(release);
  assert.ok(guard, 'invalid status OR unexpected publisher must call Die');
  assert.match(release, /function\s+Die\s*\([^)]*\)\s*\{[^}]*;\s*exit\s+1\s*\}/);
  const guardEnd = guard.index + guard[0].length;
  const dryRun = release.search(/^\s*if\s*\(\$DryRun\)/m);
  const publish = release.search(/^\s*Step\s+"Publishing\b/m);
  const github = release.search(/&\s*gh\b/);
  assert.ok(dryRun >= guardEnd, 'dry runs must also verify the signature');
  assert.ok(publish >= guardEnd, 'signature verification must precede publishing');
  assert.ok(github >= guardEnd, 'signature verification must precede GitHub commands');
});
