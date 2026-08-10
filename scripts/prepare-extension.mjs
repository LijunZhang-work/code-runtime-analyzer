import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = resolve(repositoryRoot, 'extension');
const target = resolve(extensionRoot, 'backend');

async function prepareEmbeddedBackend(destination = target) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(resolve(repositoryRoot, 'backend', 'src'), resolve(destination, 'src'), { recursive: true });
  await rm(resolve(destination, 'src', 'mcp-server.mjs'), { force: true });
  await cp(resolve(repositoryRoot, 'backend', 'dictionaries'), resolve(destination, 'dictionaries'), { recursive: true });
  await cp(resolve(repositoryRoot, 'backend', 'web-dist'), resolve(destination, 'web-dist'), { recursive: true });
}

function packageMode() {
  const packageArgument = process.argv.indexOf('--package');
  if (packageArgument === -1) return undefined;
  const mode = process.argv[packageArgument + 1];
  if (!['default', 'compatible', 'all'].includes(mode)) {
    throw new Error('打包方式只能是 default、compatible 或 all。');
  }
  return mode;
}

function copyForPackaging(source) {
  const pathFromExtensionRoot = relative(extensionRoot, source);
  if (!pathFromExtensionRoot) return true;
  const parts = pathFromExtensionRoot.split(sep);
  if (parts.includes('node_modules')) return false;
  return !basename(source).toLowerCase().endsWith('.vsix');
}

async function run(command, args, cwd) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true, shell: false });
    child.on('error', rejectPromise);
    child.on('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`扩展打包失败（退出码 ${code ?? signal ?? '未知'}）。`));
    });
  });
}

async function createPackage(layout, canonicalManifest, outputDirectory, temporaryRoot) {
  const stagingDirectory = resolve(temporaryRoot, layout);
  await cp(extensionRoot, stagingDirectory, { recursive: true, filter: copyForPackaging });
  await prepareEmbeddedBackend(resolve(stagingDirectory, 'backend'));

  const manifest = structuredClone(canonicalManifest);
  if (layout === 'compatible') {
    manifest.engines.vscode = '^1.90.0';
    manifest.contributes.viewsContainers = {
      activitybar: manifest.contributes.viewsContainers.secondarySidebar
    };
  }
  await writeFile(resolve(stagingDirectory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const lockPath = resolve(stagingDirectory, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (lock.packages?.['']?.engines) lock.packages[''].engines.vscode = manifest.engines.vscode;
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');

  const layoutLabel = layout === 'default' ? '默认右侧栏' : '兼容布局';
  const outputFile = resolve(
    outputDirectory,
    `Code-Runtime-Analyzer-${layoutLabel}-v${manifest.version}.vsix`
  );
  const vsceEntry = resolve(extensionRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
  await run(process.execPath, [vsceEntry, 'package', '--no-dependencies', '--out', outputFile], stagingDirectory);
  process.stdout.write(`${layoutLabel}安装包：${outputFile}\n`);
}

const mode = packageMode();
if (!mode) {
  await prepareEmbeddedBackend();
  process.stdout.write('扩展内置备用后台已从主后台和 Web 构建同步。\n');
} else {
  const manifest = JSON.parse(await readFile(resolve(extensionRoot, 'package.json'), 'utf8'));
  if (manifest.engines?.vscode !== '^1.106.0' || !manifest.contributes?.viewsContainers?.secondarySidebar) {
    throw new Error('默认扩展清单必须如实声明 ^1.106.0，并使用右侧栏布局。');
  }
  const outputDirectory = resolve(repositoryRoot, 'dist');
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'code-runtime-analyzer-extension-'));
  await mkdir(outputDirectory, { recursive: true });
  try {
    if (mode === 'default' || mode === 'all') {
      await createPackage('default', manifest, outputDirectory, temporaryRoot);
    }
    if (mode === 'compatible' || mode === 'all') {
      await createPackage('compatible', manifest, outputDirectory, temporaryRoot);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write(mode === 'all'
    ? '两个安装包来自同一份源码；请选择其中一个安装，不要同时安装。\n'
    : '安装包已经生成。\n');
}
