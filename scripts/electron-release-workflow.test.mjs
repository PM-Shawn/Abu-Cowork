import assert from 'node:assert/strict';
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

test('Electron build uses native runners for all three release targets', () => {
  const build = workflow('electron-build.yml');
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
  assert.equal(
    build.jobs['build-windows'].steps.find((step) => step.name === 'Windows gates').shell,
    'bash'
  );
  for (const job of [build.jobs['build-mac'], build.jobs['build-windows']]) {
    const setupNode = job.steps.find((step) => step.uses === 'actions/setup-node@v7');
    assert.equal(setupNode.with['node-version'], 24);
    const gates = job.steps.find((step) =>
      ['Gates', 'Windows gates'].includes(step.name)
    );
    assert.match(
      gates.run,
      /for attempt in 1 2 3; do[\s\S]*electron:migration-preload-verify[\s\S]*retrying after/
    );
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
  assert.match(
    installedSmoke,
    /Expected a recovery copy of the preexisting Electron conflict/
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
