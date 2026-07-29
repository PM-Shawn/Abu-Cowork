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
  }
  assert.match(
    JSON.stringify(build.jobs['build-windows']),
    /electron-windows-x64/
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
  assert.equal(release.jobs['electron-transition'].with.transition_release, true);
  assert.deepEqual(release.jobs.publish.needs, ['preflight', 'electron-transition']);

  const names = release.jobs.publish.steps.map((step) => step.name).filter(Boolean);
  const immutable = names.indexOf('Upload immutable release and updater artifacts');
  const feeds = names.indexOf('Publish and verify the three Electron feed pointers');
  const rootPointer = names.indexOf('Switch the production Tauri pointer last');
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
  assert.match(releaseSource, /--draft=false/);
});

test('packaged feeds are architecture-isolated', () => {
  const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  const buildWorkflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'electron-build.yml'),
    'utf8'
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
