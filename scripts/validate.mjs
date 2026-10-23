#!/usr/bin/env node
/**
 * 校验仓库里的每个扩展目录是否符合收录规则。
 *
 * 用法：node scripts/validate.mjs
 * 退出码：0 全部通过；1 存在错误。
 *
 * 规则来源见 CONTRIBUTING.md：
 *   1. plugin.json 可解析、字段齐全、无未知字段；
 *   2. name 与 package.json.name 一致、带 dsh-pet- 前缀、全仓库唯一；
 *   3. install.cli 去掉命令前缀后与 install.gui 一致，且是可远程安装的 spec；
 *   4. 目录名等于 name 去掉 dsh-pet- 前缀；
 *   5. package.json 声明 dsh.bundle.patch（文件可解析）与 dsh.client，存在 lib/，无生命周期脚本；
 *   6. images 每项有效：相对路径存在且为图片，或绝对地址可访问且返回图片类型。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', '.github', 'scripts', 'docs', 'node_modules']);

const NAME_RE = /^dsh-pet-[a-z0-9][a-z0-9._-]*$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
const LIFECYCLE = ['prepare', 'postinstall', 'preinstall'];
const GIT_SHORTHAND = /^(?:github|gitlab|bitbucket|gist):/i;
const GIT_URL = /^git(?:\+[a-z]+)?:\/\/|^git@[^:]+:/i;
const HOSTED_REPO = /^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i;
const TARBALL = /\.(?:tgz|tar\.gz)(?:#.*)?$/i;

const REPO = (process.env.GITHUB_REPOSITORY ?? 'PC2005-cloud/petE').toLowerCase();
const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);

/** 读取并解析 JSON；失败时记一条错误并返回 null。 */
async function readJson(file, where) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail(where, `无法解析：${error.message}`);
    return null;
  }
}

/** 校验安装 spec：必须是本仓库的 git 地址、npm 包名或 tarball。 */
function checkSpec(spec, dir, where) {
  if (typeof spec !== 'string' || spec.trim() === '') {
    fail(where, '不能为空');
    return;
  }
  const value = spec.trim();
  if (/^(?:file|link):/i.test(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || /^\.{1,2}[\\/]/.test(value)) {
    fail(where, '不能是本地路径（link:、file: 或绝对路径），必须能被别人安装');
    return;
  }
  if (GIT_SHORTHAND.test(value) || GIT_URL.test(value) || HOSTED_REPO.test(value)) {
    const expected = `github:${REPO}#path:/${dir}`;
    if (value.toLowerCase() !== expected) fail(where, `git 地址必须是 ${expected}`);
    return;
  }
  if (/^https?:\/\//i.test(value)) {
    if (!TARBALL.test(value)) fail(where, 'URL 必须指向 .tgz/.tar.gz');
    return;
  }
  if (!PACKAGE_NAME_RE.test(value)) {
    fail(where, '既不是合法包名，也不是 git 地址或 tarball');
  }
}

/** 远程配图：HEAD 不可用时退回 GET，只要求返回图片类型。 */
async function checkRemoteImage(url, where) {
  const attempt = async (method) => {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
      ...(method === 'GET' ? { headers: { Range: 'bytes=0-0' } } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get('content-type') ?? '';
    if (!type.toLowerCase().startsWith('image/')) throw new Error(`content-type 不是图片：${type || '（空）'}`);
  };
  try {
    await attempt('HEAD');
  } catch {
    try {
      await attempt('GET');
    } catch (error) {
      fail(where, `无法访问：${error.message}`);
    }
  }
}

/** 校验一个扩展目录。 */
async function checkPlugin(dir) {
  const base = join(ROOT, dir);
  const where = dir;

  const plugin = await readJson(join(base, 'plugin.json'), `${where}/plugin.json`);
  if (plugin === null) return;

  const allowed = new Set(['name', 'description', 'install', 'images']);
  for (const key of Object.keys(plugin)) {
    if (!allowed.has(key)) fail(`${where}/plugin.json`, `未知字段 ${key}`);
  }

  const { name, description, install, images } = plugin;

  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    fail(`${where}/plugin.json`, 'name 必须是 dsh-pet- 前缀的小写包名');
  } else if (name !== `dsh-pet-${dir}`) {
    fail(where, `目录名应等于包名去掉前缀（期望 ${dir}，name 是 ${name}）`);
  }

  if (typeof description !== 'string' || description.trim() === '' || description.includes('\n')) {
    fail(`${where}/plugin.json`, 'description 必须是非空单行字符串');
  }

  if (typeof install !== 'object' || install === null || Array.isArray(install)) {
    fail(`${where}/plugin.json`, 'install 必须是对象');
  } else {
    const installKeys = Object.keys(install);
    for (const key of installKeys) {
      if (key !== 'cli' && key !== 'gui') fail(`${where}/plugin.json`, `install 含未知字段 ${key}`);
    }
    const { cli, gui } = install;
    checkSpec(gui, dir, `${where}/plugin.json install.gui`);
    if (typeof cli !== 'string' || cli.trim() === '') {
      fail(`${where}/plugin.json`, 'install.cli 不能为空');
    } else if (typeof gui === 'string') {
      const expected = `dsh plugin --profile web add "${gui}"`;
      if (cli !== expected) fail(`${where}/plugin.json`, `install.cli 应为 ${expected}`);
    }
  }

  if (!Array.isArray(images)) {
    fail(`${where}/plugin.json`, 'images 必须是数组');
  } else {
    for (const [index, image] of images.entries()) {
      const at = `${where}/plugin.json images[${index}]`;
      if (typeof image !== 'string' || image.trim() === '') {
        fail(at, '必须是非空字符串');
        continue;
      }
      if (/^https?:\/\//i.test(image)) {
        await checkRemoteImage(image, at);
        continue;
      }
      if (image.includes('..')) {
        fail(at, '相对路径不能包含 ..');
        continue;
      }
      if (!IMAGE_EXT.has(extname(image).toLowerCase())) {
        fail(at, `不是图片扩展名：${image}`);
        continue;
      }
      const file = resolve(base, image);
      if (!file.startsWith(base + sep)) {
        fail(at, `路径越出扩展目录：${image}`);
        continue;
      }
      const info = await stat(file).catch(() => null);
      if (info === null || !info.isFile()) fail(at, `文件不存在：${image}`);
    }
  }

  const pkg = await readJson(join(base, 'package.json'), `${where}/package.json`);
  if (pkg !== null) {
    if (pkg.name !== name) {
      fail(`${where}/package.json`, `name 与 plugin.json 不一致（${pkg.name} ≠ ${name}）`);
    }
    const patch = pkg.dsh?.bundle?.patch;
    if (typeof patch !== 'string' || patch === '') {
      fail(`${where}/package.json`, '缺少 dsh.bundle.patch');
    } else {
      const patchFile = resolve(base, patch);
      const patchText = await readFile(patchFile, 'utf8').catch(() => null);
      if (patchText === null) {
        fail(`${where}/package.json`, `dsh.bundle.patch 指向的文件不存在：${patch}`);
      } else if (!/^\s*-\s*insert:/m.test(patchText)) {
        fail(`${where}/${patch}`, '缺少 insert 段');
      } else if (!new RegExp(`^\\s*(?:-\\s*)?id:\\s*['"]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`, 'm').test(patchText)) {
        fail(`${where}/${patch}`, `insert 条目缺少 id: ${name}`);
      }
    }
    if (pkg.dsh?.client === undefined) {
      fail(`${where}/package.json`, '缺少 dsh.client');
    }
    for (const hook of LIFECYCLE) {
      if (pkg.scripts?.[hook] !== undefined) {
        fail(`${where}/package.json`, `不允许生命周期脚本 scripts.${hook}`);
      }
    }
  }

  const lib = join(base, 'lib');
  const libInfo = await stat(lib).catch(() => null);
  if (libInfo === null || !libInfo.isDirectory()) {
    fail(where, '缺少 lib/ 构建产物');
  } else {
    const entries = await readdir(lib);
    if (entries.length === 0) fail(where, 'lib/ 是空的');
  }

  const readme = await stat(join(base, 'README.md')).catch(() => null);
  if (readme === null || !readme.isFile()) fail(where, '缺少扩展自己的 README.md');
}

/** 找出顶层所有扩展目录（含 plugin.json 的目录）。 */
async function findPlugins() {
  const entries = await readdir(ROOT, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  const plugins = [];
  for (const dir of dirs) {
    const hasPlugin = await stat(join(ROOT, dir, 'plugin.json')).catch(() => null);
    if (hasPlugin === null || !hasPlugin.isFile()) {
      fail(dir, '缺少 plugin.json');
      continue;
    }
    plugins.push(dir);
  }
  return plugins;
}

const dirs = await findPlugins();
const seen = new Map();
for (const dir of dirs) {
  await checkPlugin(dir);
  const plugin = await readJson(join(ROOT, dir, 'plugin.json'), `${dir}/plugin.json`).catch(() => null);
  if (plugin && typeof plugin.name === 'string') {
    if (seen.has(plugin.name)) fail(dir, `name 与 ${seen.get(plugin.name)} 重复`);
    else seen.set(plugin.name, dir);
  }
}

if (errors.length > 0) {
  for (const line of errors) console.error(`✗ ${line}`);
  console.error(`\n共 ${errors.length} 处问题。`);
  process.exit(1);
}

console.log(`✓ ${dirs.length} 个扩展全部通过校验。`);
