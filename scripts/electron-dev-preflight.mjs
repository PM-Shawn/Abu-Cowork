import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const REQUIRED_PACKAGES = [
  { name: 'electron', lockKey: 'node_modules/electron' },
  { name: 'node-pty', lockKey: 'node_modules/node-pty' },
];

function requiredArtifacts(repoRoot) {
  const executableSuffix = process.platform === 'win32' ? '.exe' : '';
  return [
    {
      name: 'Electron 前端',
      filePath: path.join(repoRoot, 'dist-electron-spike', 'index.html'),
    },
    {
      name: 'Agent sidecar',
      filePath: path.join(repoRoot, 'sidecar', 'index.mjs'),
    },
    {
      name: '内置 Node',
      filePath: path.join(
        repoRoot,
        'electron',
        '.runtime',
        'node-runtime',
        process.platform === 'win32' ? 'node.exe' : 'bin/node'
      ),
    },
    {
      name: '内置 Python',
      filePath: path.join(
        repoRoot,
        'electron',
        '.runtime',
        'python-runtime',
        process.platform === 'win32' ? 'python.exe' : 'bin/python3'
      ),
    },
    {
      name: 'Abu-Browser 运行时',
      filePath: path.join(repoRoot, 'electron', 'browser-runtime', 'dist', 'server.mjs'),
    },
    {
      name: 'Abu-Chrome-Bridge 运行时',
      filePath: path.join(repoRoot, 'electron', 'chrome-bridge-runtime', 'dist', 'server.mjs'),
    },
    {
      name: 'Abu-Chrome-Bridge 扩展',
      filePath: path.join(repoRoot, 'abu-chrome-extension', 'dist', 'manifest.json'),
    },
    {
      name: '电脑操控原生辅助程序',
      filePath: path.join(
        repoRoot,
        'electron',
        'native-helper',
        'target',
        'release',
        `native-helper${executableSuffix}`
      ),
    },
    {
      name: '沙箱启动器',
      filePath: path.join(
        repoRoot,
        'electron',
        'sandbox-launcher',
        'dist',
        process.platform,
        `sandbox-launcher${executableSuffix}`
      ),
    },
  ];
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function packageJsonPath(nodeModulesPath, packageName) {
  return path.join(nodeModulesPath, ...packageName.split('/'), 'package.json');
}

export function inspectElectronDevDependencies(repoRoot = DEFAULT_REPO_ROOT) {
  const nodeModulesPath = path.join(repoRoot, 'node_modules');
  const lockPath = path.join(repoRoot, 'package-lock.json');
  const issues = [];

  if (!existsSync(lockPath)) {
    return {
      issues: [{ code: 'missing-lockfile', message: '缺少 package-lock.json，无法确认锁定版本。' }],
      nodeModulesPath,
      nodeModulesTarget: null,
      nodeModulesIsSymlink: false,
    };
  }

  if (!existsSync(nodeModulesPath)) {
    return {
      issues: [{ code: 'missing-node-modules', message: '当前 worktree 尚未安装依赖。' }],
      nodeModulesPath,
      nodeModulesTarget: null,
      nodeModulesIsSymlink: false,
    };
  }

  const nodeModulesStat = lstatSync(nodeModulesPath);
  const nodeModulesIsSymlink = nodeModulesStat.isSymbolicLink();
  const nodeModulesTarget = realpathSync(nodeModulesPath);
  const lock = readJson(lockPath);

  for (const dependency of REQUIRED_PACKAGES) {
    const expectedVersion = lock.packages?.[dependency.lockKey]?.version;
    const installedPackagePath = packageJsonPath(nodeModulesPath, dependency.name);

    if (!expectedVersion) {
      issues.push({
        code: 'missing-locked-package',
        packageName: dependency.name,
        message: `锁文件中缺少 ${dependency.name}。`,
      });
      continue;
    }

    if (!existsSync(installedPackagePath)) {
      issues.push({
        code: 'missing-package',
        packageName: dependency.name,
        expectedVersion,
        message: `缺少 ${dependency.name}@${expectedVersion}。`,
      });
      continue;
    }

    const installedVersion = readJson(installedPackagePath).version;
    if (installedVersion !== expectedVersion) {
      issues.push({
        code: 'version-mismatch',
        packageName: dependency.name,
        expectedVersion,
        installedVersion,
        message: `${dependency.name} 版本不一致：需要 ${expectedVersion}，当前为 ${installedVersion}。`,
      });
    }
  }

  return {
    issues,
    nodeModulesPath,
    nodeModulesTarget,
    nodeModulesIsSymlink,
  };
}

export function verifyElectronDevRuntime(repoRoot = DEFAULT_REPO_ROOT) {
  const issues = [];
  const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));

  try {
    const electronBinary = requireFromRepo('electron');
    if (typeof electronBinary !== 'string' || !existsSync(electronBinary)) {
      issues.push({
        code: 'missing-electron-binary',
        packageName: 'electron',
        message: 'Electron 包已存在，但本机 Electron 可执行文件缺失。',
      });
    }
  } catch (error) {
    issues.push({
      code: 'electron-load-failed',
      packageName: 'electron',
      message: `Electron 无法加载：${error instanceof Error ? error.message : String(error)}`,
    });
  }

  try {
    const pty = requireFromRepo('node-pty');
    if (typeof pty?.spawn !== 'function') {
      throw new Error('模块未提供 spawn()');
    }
  } catch (error) {
    issues.push({
      code: 'node-pty-load-failed',
      packageName: 'node-pty',
      message: `node-pty 原生模块无法加载：${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return issues;
}

export function inspectElectronDevArtifacts(repoRoot = DEFAULT_REPO_ROOT) {
  return requiredArtifacts(repoRoot)
    .filter((artifact) => !existsSync(artifact.filePath))
    .map((artifact) => ({
      code: 'missing-generated-artifact',
      artifactName: artifact.name,
      filePath: artifact.filePath,
      message: `缺少 ${artifact.name} 的开发资源。`,
    }));
}

export function formatPreflightFailure(result) {
  const lines = [
    '',
    '[Abu Electron] 开发依赖未就绪，已停止启动。',
    ...result.issues.map((issue) => `  - ${issue.message}`),
  ];

  if (result.nodeModulesIsSymlink) {
    lines.push(`  - 当前 node_modules 是软链接：${result.nodeModulesTarget}`);
  }

  lines.push(
    '',
    '请在当前 worktree 执行一次：',
    '  npm run setup:electron-dev',
    '',
    '预检不会使用 npx 临时下载，也不会启动一个依赖不完整的 Electron。',
    ''
  );
  return lines.join('\n');
}

export function runElectronDevPreflight(repoRoot = DEFAULT_REPO_ROOT) {
  const result = inspectElectronDevDependencies(repoRoot);
  if (result.issues.length === 0) {
    result.issues.push(...verifyElectronDevRuntime(repoRoot));
    result.issues.push(...inspectElectronDevArtifacts(repoRoot));
  }

  if (result.issues.length > 0) {
    console.error(formatPreflightFailure(result));
    return false;
  }

  const source = result.nodeModulesIsSymlink
    ? `软链接 ${result.nodeModulesTarget}`
    : '当前 worktree';
  console.log(`[Abu Electron] 开发依赖检查通过（${source}）。`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runElectronDevPreflight() ? 0 : 1;
}
