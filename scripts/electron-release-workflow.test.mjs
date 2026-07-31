import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
});

test('release publishes only after all Electron targets and switches root pointer transactionally', () => {
  const release = workflow('release.yml');
  assert.deepEqual(Object.keys(release.jobs), [
    'preflight',
    'electron-transition',
    'publish',
  ]);
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
  assert.match(
    release.jobs.preflight.steps.find(
      (step) => step.name === 'Validate version, changelogs, and release staging logic'
    ).run,
    /npm run test:electron:release-workflow/
  );
  assert.match(
    release.jobs['electron-transition'].with.transition_release,
    /startsWith\(github\.ref_name, 'v0\.34\.'\)/,
  );
  assert.equal(release.jobs['electron-transition'].with.legacy_migration_support, true);
  assert.deepEqual(release.jobs.publish.needs, ['preflight', 'electron-transition']);

  const names = release.jobs.publish.steps.map((step) => step.name).filter(Boolean);
  const immutable = names.indexOf('Upload immutable release and updater artifacts');
  const feeds = names.indexOf('Publish and verify the three Electron feed pointers');
  const rootPointer = names.indexOf(
    'Switch the frozen production Tauri bridge pointer last'
  );
  const draft = names.indexOf('Prepare draft GitHub Release');
  const publishRelease = names.indexOf(
    'Publish GitHub Release after production verification'
  );
  assert.ok(draft >= 0);
  assert.ok(immutable >= 0);
  assert.ok(feeds > immutable);
  assert.ok(rootPointer > feeds);
  assert.ok(publishRelease > rootPointer);

  const releaseSource = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'release.yml'),
    'utf8'
  );
  assert.match(releaseSource, /gh release create "\$TAG".*--draft/s);
  assert.match(releaseSource, /restore_previous_pointer/);
  assert.match(
    releaseSource,
    /Switch the frozen production Tauri bridge pointer last[\s\S]*startsWith\(github\.ref_name, 'v0\.34\.'\)/,
  );
  assert.match(releaseSource, /normal Electron release must not stage legacy latest\.json/);
  assert.match(releaseSource, /--draft=false/);
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
  assert.match(builder, /electron\/mac-arm64\//);
  assert.match(buildWorkflow, /electron\/\$\{FEED_CHANNEL\}\//);
  assert.match(buildWorkflow, /electron\/win-x64\//);
  assert.equal(
    (buildWorkflow.match(/--config\.detectUpdateChannel=false/g) || []).length,
    2,
    'RC validation must emit the same latest*.yml feed pointers as a stable release'
  );
});
