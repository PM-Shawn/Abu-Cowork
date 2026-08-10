import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function workflow(name) {
  return YAML.parse(
    fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8')
  );
}

function runBash(script, env) {
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function writeExecutable(directory, name, source) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, source, 'utf8');
  fs.chmodSync(file, 0o755);
}

function createReleaseVisibilityHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-release-visibility-'));
  const bin = path.join(directory, 'bin');
  const bucket = path.join(directory, 'bucket');
  const stage = path.join(directory, 'release-stage');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(bucket, { recursive: true });
  fs.mkdirSync(stage, { recursive: true });

  const pointers = [
    ['feeds/mac-arm64/latest-mac.yml', 'electron/mac-arm64/latest-mac.yml'],
    ['feeds/mac-x64/latest-mac.yml', 'electron/mac-x64/latest-mac.yml'],
    ['feeds/win-x64/latest.yml', 'electron/win-x64/latest.yml'],
  ];
  for (const [local, remote] of pointers) {
    const staged = path.join(stage, local);
    const published = path.join(bucket, remote);
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.mkdirSync(path.dirname(published), { recursive: true });
    fs.writeFileSync(staged, `version: 0.34.0\npath: new-${path.basename(remote)}\n`);
    fs.writeFileSync(published, `version: 0.33.0\npath: old-${path.basename(remote)}\n`);
  }
  fs.writeFileSync(
    path.join(stage, 'feed-pointer-map.tsv'),
    `${pointers.map(([local, remote]) => `${local}\t${remote}`).join('\n')}\n`,
  );
  const websitePointer = ['website-release.json', 'electron/latest-release.json'];
  fs.writeFileSync(
    path.join(stage, websitePointer[0]),
    '{"schema_version":1,"version":"v0.34.0"}\n',
  );
  fs.mkdirSync(path.dirname(path.join(bucket, websitePointer[1])), { recursive: true });
  fs.writeFileSync(
    path.join(bucket, websitePointer[1]),
    '{"schema_version":1,"version":"v0.33.0"}\n',
  );
  fs.writeFileSync(
    path.join(stage, 'website-pointer-map.tsv'),
    `${websitePointer[0]}\t${websitePointer[1]}\n`,
  );
  fs.writeFileSync(path.join(stage, 'latest.json'), '{"version":"0.34.0"}\n');
  fs.writeFileSync(path.join(bucket, 'latest.json'), '{"version":"0.33.0"}\n');
  fs.writeFileSync(path.join(directory, 'release-state'), 'draft\n');

  writeExecutable(bin, 'ossutil', `#!/usr/bin/env bash
set -euo pipefail
map_path() {
  case "$1" in
    oss://test-bucket/*) printf '%s/%s' "$FAKE_BUCKET" "\${1#oss://test-bucket/}" ;;
    *) printf '%s' "$1" ;;
  esac
}
case "$1" in
  cp)
    source_path="$(map_path "$2")"
    target_path="$(map_path "$3")"
    /bin/mkdir -p "$(dirname "$target_path")"
    /bin/cp "$source_path" "$target_path"
    ;;
  rm)
    target_path="$(map_path "$2")"
    /bin/rm -f "$target_path"
    ;;
  *)
    echo "unsupported fake ossutil command: $1" >&2
    exit 2
    ;;
esac
`);
  writeExecutable(bin, 'curl', `#!/usr/bin/env bash
set -euo pipefail
output=''
write_format=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -w) write_format="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://example.invalid/*)
    remote="\${url#https://example.invalid/}"
    ;;
  https://abu-agent.oss-cn-beijing.aliyuncs.com/*)
    remote="\${url#https://abu-agent.oss-cn-beijing.aliyuncs.com/}"
    ;;
  *)
    echo "unexpected fake curl URL: $url" >&2
    exit 2
    ;;
esac
remote="\${remote%%[?]*}"
if [ "$remote" = 'latest.json' ] && [ "\${FAIL_ROOT_CDN:-0}" = '1' ]; then
  printf '%s\n' '{"version":"corrupt"}' > "$output"
elif [ "$remote" = 'electron/latest-release.json' ] && [ "\${FAIL_WEBSITE_CDN:-0}" = '1' ] && [[ "$url" == *'?release='* ]]; then
  printf '%s\n' '{"schema_version":1,"version":"v9.9.9"}' > "$output"
elif [ -f "$FAKE_BUCKET/$remote" ]; then
  /bin/cp "$FAKE_BUCKET/$remote" "$output"
else
  : > "$output"
  [ -z "$write_format" ] || printf '404'
  exit 0
fi
[ -z "$write_format" ] || printf '200'
`);
  writeExecutable(bin, 'gh', `#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *' --draft=false '*)
    printf 'published\n' > "$FAKE_RELEASE_STATE"
    # Model the ambiguous network case: GitHub accepted the mutation but the
    # client lost the response and exits non-zero.
    if [ "\${FAIL_GH_PUBLISH:-0}" = '1' ]; then exit 1; fi
    ;;
  *' --draft=true '*) printf 'draft\n' > "$FAKE_RELEASE_STATE" ;;
esac
`);
  writeExecutable(bin, 'node', `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == *validate-electron-feed-version.mjs ]] && [ "\${FAIL_FEED_VERSION:-0}" = '1' ]; then
  exit 1
fi
if [[ "$1" == *validate-website-release-version.mjs ]] && [ "\${FAIL_WEBSITE_VERSION:-0}" = '1' ]; then
  exit 1
fi
exit 0
`);

  const release = workflow('release.yml');
  const step = release.jobs.publish.steps.find(
    (candidate) => candidate.name === 'Publish and verify the release visibility transaction',
  );
  const script = step.run.replaceAll(
    '${{ github.repository }}',
    'PM-Shawn/Abu-Cowork',
  );
  const environment = {
    BUCKET: 'oss://test-bucket',
    PUBLIC_BASE: 'https://example.invalid',
    GH_TOKEN: 'test-token',
    LEGACY_TRANSITION: 'true',
    VERSION: 'v0.34.0',
    GITHUB_RUN_ID: '123',
    FAKE_BUCKET: bucket,
    FAKE_RELEASE_STATE: path.join(directory, 'release-state'),
    PATH: `${bin}:${process.env.PATH}`,
  };
  const run = (extraEnv = {}) => spawnSync('bash', ['-c', script], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, ...environment, ...extraEnv },
  });
  const readSurface = () => ({
    feeds: pointers.map(([, remote]) => fs.readFileSync(path.join(bucket, remote), 'utf8')),
    website: fs.readFileSync(path.join(bucket, websitePointer[1]), 'utf8'),
    latest: fs.readFileSync(path.join(bucket, 'latest.json'), 'utf8'),
    release: fs.readFileSync(path.join(directory, 'release-state'), 'utf8'),
  });
  return { directory, run, readSurface };
}

function createWebsiteMetadataRepairHarness({ existing = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-website-repair-'));
  const bin = path.join(directory, 'bin');
  const bucket = path.join(directory, 'bucket');
  const stage = path.join(directory, 'release-stage');
  const remote = path.join(bucket, 'electron', 'latest-release.json');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(
    path.join(stage, 'website-release.json'),
    '{"schema_version":1,"version":"v0.36.0"}\n',
  );
  if (existing) {
    fs.writeFileSync(remote, '{"schema_version":1,"version":"v0.35.0"}\n');
  }

  writeExecutable(bin, 'ossutil', `#!/usr/bin/env bash
set -euo pipefail
map_path() {
  case "$1" in
    oss://test-bucket/*) printf '%s/%s' "$FAKE_BUCKET" "\${1#oss://test-bucket/}" ;;
    *) printf '%s' "$1" ;;
  esac
}
case "$1" in
  cp)
    source_path="$(map_path "$2")"
    target_path="$(map_path "$3")"
    if [ "\${FAIL_RESTORE:-0}" = '1' ] && [[ "$source_path" == */previous.json ]]; then
      exit 1
    fi
    /bin/mkdir -p "$(dirname "$target_path")"
    /bin/cp "$source_path" "$target_path"
    ;;
  rm)
    /bin/rm -f "$(map_path "$2")"
    ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(bin, 'curl', `#!/usr/bin/env bash
set -euo pipefail
output=''
write_format=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -w) write_format="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "$url" == *'?backup='* ]] && [ "\${FAIL_SNAPSHOT:-0}" = '1' ]; then
  printf '%s\n' '{"error":"temporary"}' > "$output"
  [ -z "$write_format" ] || printf '500'
  exit 0
fi
if [[ "$url" == *'?repair='* ]] && [ "\${FAIL_VERIFY:-0}" = '1' ]; then
  printf '%s\n' '{"schema_version":1,"version":"v9.9.9"}' > "$output"
  exit 0
fi
if [ -f "$FAKE_REMOTE" ]; then
  /bin/cp "$FAKE_REMOTE" "$output"
  [ -z "$write_format" ] || printf '200'
else
  : > "$output"
  [ -z "$write_format" ] || printf '404'
fi
`);
  writeExecutable(bin, 'node', `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == *validate-website-release-version.mjs ]] && [ "\${FAIL_WEBSITE_VERSION:-0}" = '1' ]; then
  exit 1
fi
exit 0
`);

  const release = workflow('release.yml');
  const step = release.jobs['repair-website-metadata'].steps.find(
    (candidate) => candidate.name === 'Publish and verify website metadata repair',
  );
  const environment = {
    BUCKET: 'oss://test-bucket',
    PUBLIC_BASE: 'https://example.invalid',
    INPUT_VERSION: 'v0.36.0',
    GITHUB_RUN_ID: '456',
    FAKE_BUCKET: bucket,
    FAKE_REMOTE: remote,
    PATH: `${bin}:${process.env.PATH}`,
  };
  const run = (extraEnv = {}) => spawnSync('bash', ['-c', step.run], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, ...environment, ...extraEnv },
  });
  const readSurface = () => fs.existsSync(remote) ? fs.readFileSync(remote, 'utf8') : null;
  return { directory, run, readSurface };
}

test('Electron build uses native runners for all three release targets', () => {
  const build = workflow('electron-build.yml');
  const manualTarget = build.on.workflow_dispatch.inputs.target_platform;
  assert.equal(manualTarget.type, 'choice');
  assert.deepEqual(manualTarget.options, ['all', 'windows', 'mac']);
  assert.equal(manualTarget.default, 'all');
  assert.deepEqual(build.on.workflow_call.inputs.target_platform, {
    description: 'Limit the reusable build to one platform family',
    type: 'string',
    default: 'all',
  });
  const targetValidation = build.jobs['validate-target-platform'];
  assert.equal(targetValidation['runs-on'], 'ubuntu-latest');
  const targetValidationStep = targetValidation.steps.find(
    (step) => step.name === 'Require a supported target platform'
  );
  assert.equal(
    targetValidationStep.env.TARGET_PLATFORM,
    '${{ inputs.target_platform }}'
  );
  for (const target of ['', 'all', 'windows', 'mac']) {
    assert.equal(
      runBash(targetValidationStep.run, { TARGET_PLATFORM: target }).status,
      0,
      `target_platform=${target || '<empty>'} must be accepted`
    );
  }
  const invalidTarget = runBash(targetValidationStep.run, {
    TARGET_PLATFORM: 'windwos',
  });
  assert.equal(invalidTarget.status, 1);
  assert.match(invalidTarget.stderr, /Unsupported target_platform: windwos/);
  const macMatrix = build.jobs['build-mac'].strategy.matrix.include;
  assert.deepEqual(
    macMatrix.map((entry) => ({
      runner: entry.runner,
      arch: entry.transition_arch,
      channel: entry.feed_channel,
      artifact: entry.artifact_name,
    })),
    [
      {
        runner: 'macos-15',
        arch: 'arm64',
        channel: 'mac-arm64',
        artifact: 'electron-mac-arm64',
      },
      {
        runner: 'macos-15-intel',
        arch: 'x86_64',
        channel: 'mac-x64',
        artifact: 'electron-mac-x64',
      },
    ]
  );
  assert.equal(build.jobs['build-windows']['runs-on'], 'windows-latest');
  assert.equal(build.jobs['build-mac'].needs, 'validate-target-platform');
  assert.equal(build.jobs['build-windows'].needs, 'validate-target-platform');
  for (const job of [build.jobs['build-mac'], build.jobs['build-windows']]) {
    assert.equal(job.env.VITE_CONSOLE_URL, '${{ secrets.VITE_CONSOLE_URL }}');
    const targetCheck = job.steps.find(
      (step) => step.name === 'Require diagnostic upload target'
    );
    assert.equal(targetCheck.run, 'node scripts/validate-diagnostic-upload-target.mjs');
    assert.equal(
      targetCheck.if,
      "${{ github.event_name != 'pull_request' && github.repository == 'PM-Shawn/Abu-Cowork' }}"
    );
  }
  assert.equal(
    build.jobs['build-mac'].if,
    "${{ github.event_name != 'pull_request' && (inputs.target_platform == '' || inputs.target_platform == 'all' || inputs.target_platform == 'mac') }}"
  );
  assert.equal(
    build.jobs['build-windows'].if,
    "${{ github.event_name == 'pull_request' || inputs.target_platform == '' || inputs.target_platform == 'all' || inputs.target_platform == 'windows' }}"
  );
  const windowsGateIds = [
    'windows_frontend_gates',
    'windows_electron_migration_gates',
    'windows_host_security_gates',
    'windows_active_window_probe',
    'windows_native_helper_gates',
  ];
  for (const id of windowsGateIds) {
    const step = build.jobs['build-windows'].steps.find((candidate) => candidate.id === id);
    assert.equal(step.shell, 'bash');
    assert.equal(step['continue-on-error'], true);
  }
  const requireWindowsGates = build.jobs['build-windows'].steps.find(
    (step) => step.name === 'Require all Windows gates'
  );
  assert.equal(requireWindowsGates.if, '${{ always() && !cancelled() }}');
  assert.deepEqual(requireWindowsGates.env, {
    FRONTEND_OUTCOME: '${{ steps.windows_frontend_gates.outcome }}',
    ELECTRON_MIGRATION_OUTCOME:
      '${{ steps.windows_electron_migration_gates.outcome }}',
    HOST_SECURITY_OUTCOME: '${{ steps.windows_host_security_gates.outcome }}',
    ACTIVE_WINDOW_OUTCOME: '${{ steps.windows_active_window_probe.outcome }}',
    NATIVE_HELPER_OUTCOME: '${{ steps.windows_native_helper_gates.outcome }}',
  });
  for (const gate of [
    'frontend:$FRONTEND_OUTCOME',
    'electron-migration:$ELECTRON_MIGRATION_OUTCOME',
    'host-security:$HOST_SECURITY_OUTCOME',
    'active-window:$ACTIVE_WINDOW_OUTCOME',
    'native-helper:$NATIVE_HELPER_OUTCOME',
  ]) {
    assert.match(requireWindowsGates.run, new RegExp(gate.replace('$', '\\$')));
  }
  assert.match(requireWindowsGates.run, /Windows gates failed/);
  const successfulOutcomes = {
    FRONTEND_OUTCOME: 'success',
    ELECTRON_MIGRATION_OUTCOME: 'success',
    HOST_SECURITY_OUTCOME: 'success',
    ACTIVE_WINDOW_OUTCOME: 'success',
    NATIVE_HELPER_OUTCOME: 'success',
  };
  assert.equal(runBash(requireWindowsGates.run, successfulOutcomes).status, 0);
  for (const [outcome, label] of [
    ['FRONTEND_OUTCOME', 'frontend'],
    ['ELECTRON_MIGRATION_OUTCOME', 'electron-migration'],
    ['HOST_SECURITY_OUTCOME', 'host-security'],
    ['ACTIVE_WINDOW_OUTCOME', 'active-window'],
    ['NATIVE_HELPER_OUTCOME', 'native-helper'],
  ]) {
    const failedGate = runBash(requireWindowsGates.run, {
      ...successfulOutcomes,
      [outcome]: 'failure',
    });
    assert.equal(failedGate.status, 1);
    assert.match(failedGate.stderr, new RegExp(`${label}:failure`));
  }
  const windowsStepNames = build.jobs['build-windows'].steps.map((step) => step.name);
  assert.ok(
    windowsStepNames.indexOf('Require all Windows gates') <
      windowsStepNames.indexOf('Resolve Windows candidate configuration')
  );
  for (const job of [build.jobs['build-mac'], build.jobs['build-windows']]) {
    const setupNode = job.steps.find((step) => step.uses === 'actions/setup-node@v7');
    assert.equal(setupNode.with['node-version'], 24);
  }
  const macGates = build.jobs['build-mac'].steps.find((step) => step.name === 'Gates');
  const windowsMigrationGates = build.jobs['build-windows'].steps.find(
    (step) => step.id === 'windows_electron_migration_gates'
  );
  for (const gates of [macGates, windowsMigrationGates]) {
    assert.match(
      gates.run,
      /for attempt in 1 2 3; do[\s\S]*electron:migration-preload-verify[\s\S]*retrying after/
    );
  }
  assert.match(macGates.run, /npm run test:electron:release-workflow/);
  assert.match(
    build.jobs['build-windows'].steps.find(
      (step) => step.id === 'windows_host_security_gates'
    ).run,
    /npm run test:electron:release-workflow/
  );
  for (const job of [build.jobs['build-mac'], build.jobs['build-windows']]) {
    const nativeProbe = job.steps.find((step) =>
      ['Native active-window probe', 'Windows native active-window probe'].includes(step.name)
    );
    assert.equal(nativeProbe.env.ABU_RUN_NATIVE_ACTIVE_WINDOW_TEST, '1');
    assert.match(nativeProbe.run, /for attempt in 1 2 3; do/);
  }
  assert.match(
    JSON.stringify(build.jobs['build-windows']),
    /electron-windows-x64/
  );
  assert.match(
    build.jobs['build-mac'].steps.find(
      (step) => step.name === 'Build, sign, and notarize Electron'
    ).run,
    /for attempt in 1 2 3/
  );
  assert.match(
    build.jobs['build-windows'].steps.find(
      (step) => step.name === 'Build unsigned current-user NSIS and update metadata'
    ).run,
    /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/
  );
  const installedSmoke = fs.readFileSync(
    path.join(root, 'scripts', 'electron-windows-installed-smoke.ps1'),
    'utf8'
  );
  assert.match(installedSmoke, /ABU_E2E_AUTO_CONFIRM_TRANSITION/);
  assert.match(
    installedSmoke,
    /Tauri updater arguments did not relaunch the installed Electron app/
  );
  assert.match(installedSmoke, /updaterRelaunchVerified=\$updaterRelaunchVerified/);
  assert.match(installedSmoke, /Tauri source did not win the migration conflict/);
  assert.match(installedSmoke, /AbuElectronTransitionHidden/);
  assert.match(
    installedSmoke,
    /Electron uninstall did not clear the legacy Tauri transition marker/
  );
  assert.match(
    installedSmoke,
    /Electron uninstall state did not converge within 120 seconds/
  );
  assert.match(installedSmoke, /Installed Abu processes did not stop before uninstall/);
  assert.match(installedSmoke, /ProcessName -like "Un_\*"/);
  assert.match(installedSmoke, /TotalSeconds -ge 3/);
  assert.match(installedSmoke, /activeUninstallerPids=/);
  assert.match(installedSmoke, /Test-Path \$installedExe\.FullName/);
  assert.match(
    installedSmoke,
    /Expected a recovery copy of the preexisting Electron conflict/
  );
  const transitionInstaller = fs.readFileSync(
    path.join(root, 'build', 'electron-transition-installer.nsh'),
    'utf8'
  );
  assert.match(
    transitionInstaller,
    /ReadRegDWORD \$R0 HKCU .* "AbuElectronTransitionHidden"/
  );
  assert.ok(
    transitionInstaller.indexOf('SetRegView 64') <
      transitionInstaller.indexOf('ReadRegDWORD $R0 HKCU'),
    'the generic embedded uninstaller must switch to the x64 registry view before reading the marker'
  );
  assert.match(
    transitionInstaller,
    /DeleteRegValue HKCU .* "SystemComponent"/
  );
  assert.match(
    transitionInstaller,
    /DeleteRegValue HKCU .* "AbuElectronTransitionHidden"/
  );
  assert.match(
    transitionInstaller,
    /ReadRegDWORD \$R1 HKCU .* "SystemComponent"/
  );
  assert.match(
    transitionInstaller,
    /Abort "Could not restore the preserved Abu rollback entry\."/
  );
  assert.match(
    transitionInstaller,
    /Abort "Could not clear the Abu rollback transition marker\."/
  );
});

test('release publishes only after all Electron targets and switches root pointer transactionally', () => {
  const release = workflow('release.yml');
  const manualRelease = release.on.workflow_dispatch.inputs;
  assert.equal(manualRelease.transition_version.type, 'string');
  assert.equal(manualRelease.transition_version.required, true);
  assert.equal(manualRelease.website_metadata_only.type, 'boolean');
  assert.equal(manualRelease.website_metadata_only.default, false);
  assert.deepEqual(manualRelease.target_platform.options, ['all', 'windows', 'mac']);
  assert.equal(manualRelease.target_platform.default, 'all');
  assert.deepEqual(Object.keys(release.jobs), [
    'preflight',
    'electron-transition',
    'publish',
    'repair-website-metadata',
  ]);
  assert.deepEqual(release.permissions, { contents: 'read' });
  assert.deepEqual(release.jobs.publish.permissions, { contents: 'write' });
  for (const jobName of ['preflight', 'publish']) {
    const setupNode = release.jobs[jobName].steps.find(
      (step) => step.uses === 'actions/setup-node@v7'
    );
    assert.equal(setupNode.with['node-version'], 24);
  }
  assert.equal(
    release.jobs['electron-transition'].uses,
    './.github/workflows/electron-build.yml'
  );
  assert.equal(release.jobs['electron-transition'].secrets, 'inherit');
  assert.match(
    release.jobs['electron-transition'].if,
    /github\.repository == 'PM-Shawn\/Abu-Cowork'.*workflow_dispatch/
  );
  assert.match(release.jobs['electron-transition'].if, /website_metadata_only/);
  assert.match(
    release.jobs.preflight.steps.find(
      (step) => step.name === 'Validate version, changelogs, and release staging logic'
    ).run,
    /npm run test:electron:release-workflow/
  );
  assert.match(
    release.jobs['electron-transition'].with.transition_release,
    /github\.event_name == 'push'.*github\.ref_name == 'v0\.34\.2'/,
  );
  assert.equal(release.jobs['electron-transition'].with.legacy_migration_support, true);
  assert.match(
    release.jobs['electron-transition'].with.transition_version,
    /workflow_dispatch.*inputs\.transition_version.*github\.ref_name/,
  );
  assert.match(
    release.jobs['electron-transition'].with.target_platform,
    /workflow_dispatch.*inputs\.target_platform.*'all'/,
  );
  assert.deepEqual(release.jobs.publish.needs, ['preflight', 'electron-transition']);
  assert.match(
    release.jobs.publish.if,
    /github\.event_name == 'push'.*!contains\(github\.ref_name, '-'\)/,
  );
  assert.match(
    release.jobs.publish.if,
    /github\.repository == 'PM-Shawn\/Abu-Cowork'/
  );

  const names = release.jobs.publish.steps.map((step) => step.name).filter(Boolean);
  const immutable = names.indexOf('Upload immutable release and updater artifacts');
  const visibility = names.indexOf('Publish and verify the release visibility transaction');
  const draft = names.indexOf('Prepare draft GitHub Release');
  assert.ok(draft >= 0);
  assert.ok(immutable >= 0);
  assert.ok(visibility > immutable);

  const draftStep = release.jobs.publish.steps.find(
    (step) => step.name === 'Prepare draft GitHub Release',
  );
  assert.match(draftStep.run, /--json isDraft/);
  assert.match(draftStep.run, /already public; refusing to replace immutable assets/);
  assert.match(draftStep.run, /gh release download[\s\S]*cmp "\$asset" "\$downloaded"/);
  assert.equal(
    draftStep.run.split('\n').filter((line) => line.includes('gh release upload'))
      .every((line) => !line.includes('--clobber')),
    true,
  );
  const immutableStep = release.jobs.publish.steps.find(
    (step) => step.name === 'Upload immutable release and updater artifacts',
  );
  assert.match(immutableStep.run, /X-Oss-Forbid-Overwrite:true/);
  assert.match(immutableStep.run, /200\)[\s\S]*cmp "release-stage\/\$local" "\$downloaded"/);
  assert.match(immutableStep.run, /404\)[\s\S]*ossutil cp/);

  const releaseSource = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'release.yml'),
    'utf8'
  );
  assert.match(releaseSource, /gh release create "\$TAG".*--draft/s);
  assert.match(releaseSource, /restore_release_transaction/);
  assert.match(releaseSource, /UPDATED_POINTERS/);
  assert.match(releaseSource, /ossutil rm "\$BUCKET\/\$remote" -f/);
  assert.match(releaseSource, /validate-electron-feed-version\.mjs/);
  assert.match(releaseSource, /OSSUTIL_VERSION="1\.7\.19"/);
  assert.match(releaseSource, /ossutil-v\$\{OSSUTIL_VERSION\}-linux-amd64\.zip/);
  assert.match(
    releaseSource,
    /dcc512e4a893e16bbee63bc769339d8e56b21744fd83c8212a9d8baf28767343/,
  );
  assert.match(releaseSource, /sha256sum -c -/);
  assert.doesNotMatch(releaseSource, /install\.sh.*sudo bash/);
  assert.match(releaseSource, /LEGACY_TRANSITION: \$\{\{ github\.ref_name == 'v0\.34\.2' \}\}/);
  assert.doesNotMatch(releaseSource, /startsWith\(github\.ref_name, 'v0\.34\.'\)/);
  assert.match(releaseSource, /normal Electron release must not stage legacy latest\.json/);
  assert.match(releaseSource, /electron\/latest-release\.json/);
  assert.match(releaseSource, /validate-website-release-version\.mjs/);
  assert.match(releaseSource, /website-pointer-map\.tsv/);
  assert.match(releaseSource, /--draft=false/);
  assert.match(releaseSource, /--draft=true/);
  assert.match(
    releaseSource,
    /RELEASE_PUBLISH_ATTEMPTED=1\s+gh release edit "\$VERSION"[^\n]*--draft=false/,
  );

  const repair = release.jobs['repair-website-metadata'];
  assert.match(repair.if, /workflow_dispatch.*website_metadata_only/);
  assert.equal(repair.needs, undefined);
  assert.match(release.jobs.preflight.if, /website_metadata_only/);
  assert.equal(
    repair.steps.find((step) => step.uses === 'actions/checkout@v7').with['fetch-depth'],
    0,
  );
  const generateRepair = repair.steps.find(
    (step) => step.name === 'Generate metadata from the existing stable release',
  );
  assert.match(generateRepair.run, /git show "\$TAG:CHANGELOG\.md"/);
  assert.match(generateRepair.run, /git show "\$TAG:CHANGELOG\.zh-CN\.md"/);
  assert.match(generateRepair.run, /--exclude-drafts --exclude-pre-releases/);
  assert.match(generateRepair.run, /"\$TAG" != "\$LATEST_STABLE_TAG"/);
  assert.ok(
    repair.steps.some((step) => step.name === 'Publish and verify website metadata repair'),
  );
});

test('website metadata repair makes zero writes when the initial snapshot fails', (t) => {
  const harness = createWebsiteMetadataRepairHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const before = harness.readSurface();
  const result = harness.run({ FAIL_SNAPSHOT: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(harness.readSurface(), before);
});

test('website metadata repair makes zero writes when downgrade validation fails', (t) => {
  const harness = createWebsiteMetadataRepairHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const before = harness.readSurface();
  const result = harness.run({ FAIL_WEBSITE_VERSION: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(harness.readSurface(), before);
});

test('website metadata repair restores an existing pointer after verification fails', (t) => {
  const harness = createWebsiteMetadataRepairHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const before = harness.readSurface();
  const result = harness.run({ FAIL_VERIFY: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(harness.readSurface(), before);
});

test('website metadata repair removes a newly created pointer after verification fails', (t) => {
  const harness = createWebsiteMetadataRepairHarness({ existing: false });
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const result = harness.run({ FAIL_VERIFY: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(harness.readSurface(), null, `${result.stdout}\n${result.stderr}`);
});

test('website metadata repair reports rollback failure without hiding the original failure', (t) => {
  const harness = createWebsiteMetadataRepairHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const result = harness.run({ FAIL_VERIFY: '1', FAIL_RESTORE: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Website metadata repair rollback failed/);
});

test('website metadata repair publishes the staged pointer on success', (t) => {
  const harness = createWebsiteMetadataRepairHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const result = harness.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(harness.readSurface(), '{"schema_version":1,"version":"v0.36.0"}\n');
});

test('release visibility makes zero writes when a current feed is newer', (t) => {
  const harness = createReleaseVisibilityHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const before = harness.readSurface();
  const result = harness.run({ FAIL_FEED_VERSION: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(harness.readSurface(), before);
});

test('release visibility makes zero writes when website metadata is newer', (t) => {
  const harness = createReleaseVisibilityHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const before = harness.readSurface();
  const result = harness.run({ FAIL_WEBSITE_VERSION: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(harness.readSurface(), before);
});

test('release visibility restores all feeds after an ambiguous GitHub publish failure', (t) => {
  const harness = createReleaseVisibilityHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const before = harness.readSurface();
  const result = harness.run({ FAIL_GH_PUBLISH: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(harness.readSurface(), before);
});

test('release visibility restores feeds, root pointer, and draft after CDN verification fails', (t) => {
  const harness = createReleaseVisibilityHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const before = harness.readSurface();
  const result = harness.run({ FAIL_ROOT_CDN: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(harness.readSurface(), before);
});

test('release visibility restores all pointers after website CDN verification fails', (t) => {
  const harness = createReleaseVisibilityHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const before = harness.readSurface();
  const result = harness.run({ FAIL_WEBSITE_CDN: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(harness.readSurface(), before);
});

test('release visibility publishes all surfaces together on success', (t) => {
  const harness = createReleaseVisibilityHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const result = harness.run();
  assert.equal(result.status, 0, result.stderr);
  const surface = harness.readSurface();
  assert.ok(surface.feeds.every((feed) => feed.includes('version: 0.34.0')));
  assert.equal(surface.website, '{"schema_version":1,"version":"v0.34.0"}\n');
  assert.equal(surface.latest, '{"version":"0.34.0"}\n');
  assert.equal(surface.release, 'published\n');
});

test('normal Electron release leaves the frozen Tauri root pointer untouched', (t) => {
  const harness = createReleaseVisibilityHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const before = harness.readSurface();
  const result = harness.run({ LEGACY_TRANSITION: 'false', VERSION: 'v0.35.0' });
  assert.equal(result.status, 0, result.stderr);
  const surface = harness.readSurface();
  assert.equal(surface.latest, before.latest);
  assert.equal(surface.release, 'published\n');
  assert.ok(surface.feeds.every((feed) => feed.includes('version: 0.34.0')));
});

test('packaged feeds are architecture-isolated', () => {
  const builderPath = path.join(root, 'electron-builder.yml');
  const builder = fs.readFileSync(builderPath, 'utf8');
  const builderConfig = YAML.parse(builder);
  const buildWorkflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'electron-build.yml'),
    'utf8'
  );
  assert.ok(
    builderConfig.extraResources.some(
      (resource) =>
        resource.from === 'electron/.runtime/node-runtime/node_modules' &&
        resource.to === 'node-runtime/node_modules'
    ),
    'Windows packages must explicitly retain the root-level bundled npm/npx tree'
  );
  assert.equal(builderConfig.publish, null);
  assert.equal(builderConfig.extraMetadata.abuRelease.officialBuild, false);
  assert.doesNotMatch(builder, /abu-agent\.oss-cn-beijing\.aliyuncs\.com/);
  assert.match(buildWorkflow, /electron\/\$\{FEED_CHANNEL\}\//);
  assert.match(buildWorkflow, /electron\/win-x64\//);
  assert.match(
    buildWorkflow,
    /github\.event_name != 'pull_request' && github\.repository == 'PM-Shawn\/Abu-Cowork'/,
  );
  assert.match(buildWorkflow, /"\$\{\{ github\.event_name \}\}" -ne "pull_request"/);
  assert.match(buildWorkflow, /--allow-equal true/);
  assert.equal(
    (buildWorkflow.match(/ABU_BUILD_VERSION=/g) || []).length,
    2,
    'macOS and Windows must compile the renderer with the packaged candidate version'
  );
  assert.match(buildWorkflow, /ABU_BUILD_VERSION=\$TRANSITION_VERSION/);
  assert.match(buildWorkflow, /ABU_BUILD_VERSION=\$candidate/);
  assert.equal(
    (buildWorkflow.match(/--config\.extraMetadata\.abuRelease\.officialBuild=true/g) || []).length,
    2,
    'only official CI builds may arm the production updater'
  );
  assert.equal(
    (buildWorkflow.match(/--config\.publish\.provider=generic/g) || []).length,
    2,
    'official CI must inject the provider together with the feed URL'
  );
  assert.equal(
    (buildWorkflow.match(/--config\.detectUpdateChannel=false/g) || []).length,
    2,
    'RC validation must emit the same latest*.yml feed pointers as a stable release'
  );
  const windowsFeedVerification = workflow('electron-build.yml').jobs[
    'build-windows'
  ].steps.find(
    (step) => step.name === 'Verify installer, blockmap, latest.yml, and packaged feed'
  );
  assert.equal(
    windowsFeedVerification.if,
    "${{ github.event_name != 'pull_request' && github.repository == 'PM-Shawn/Abu-Cowork' }}"
  );
});
