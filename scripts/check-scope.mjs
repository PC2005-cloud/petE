#!/usr/bin/env node
/**
 * 检查一个 PR 是否只改动了一个扩展目录。
 *
 * 用法：
 *   SCOPE_BASE_SHA=<base-sha> node scripts/check-scope.mjs   CI：比较 base 与 HEAD
 *   node scripts/check-scope.mjs --worktree                   本地：比较未提交的改动
 *
 * 规则：
 *   - 所有改动路径必须位于同一个顶层目录下；
 *   - 该目录里必须有 plugin.json（因此删除、改名都会被拦下，交给维护者处理）；
 *   - 根目录文件、.github/、scripts/ 等一律拒绝。
 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worktree = process.argv.includes('--worktree');
const base = process.env.SCOPE_BASE_SHA;

if (!worktree && (base === undefined || base.trim() === '')) {
  console.error('✗ 缺少 SCOPE_BASE_SHA（或使用 --worktree 比较本地未提交改动）');
  process.exit(1);
}

let sequence = 0;

/**
 * 运行 git 并返回 stdout。
 *
 * 输出重定向到临时文件，而不是用管道捕获：某些受限环境禁止子进程使用管道
 * （child_process 的默认 stdio 会触发 spawn EPERM）。
 */
function git(args) {
  sequence += 1;
  const file = join(tmpdir(), `dsh-scope-${process.pid}-${sequence}.txt`);
  const fd = openSync(file, 'w');
  let failed;
  try {
    execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', fd, 'inherit'] });
  } catch (error) {
    failed = error;
  } finally {
    closeSync(fd);
  }
  const text = readFileSync(file, 'utf8');
  unlinkSync(file);
  if (failed !== undefined) {
    console.error(`✗ 无法读取改动：${failed.message}`);
    process.exit(1);
  }
  return text;
}

/** 解析 `git diff --name-status`：每一行是 `状态\t路径`，重命名/复制带两个路径。 */
function parseNameStatus(text, paths) {
  for (const line of text.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    if (parts[0].startsWith('R') || parts[0].startsWith('C')) {
      paths.push(parts[1], parts[2]);
    } else {
      paths.push(parts[1]);
    }
  }
}

const paths = [];
if (worktree) {
  parseNameStatus(git(['diff', '--name-status', '-M', 'HEAD']), paths);
  for (const line of git(['ls-files', '--others', '--exclude-standard']).split('\n')) {
    if (line.trim() !== '') paths.push(line.trim());
  }
} else {
  parseNameStatus(git(['diff', '--name-status', '-M', `${base}...HEAD`]), paths);
}

if (paths.length === 0) {
  console.error('✗ 没有检测到改动');
  process.exit(1);
}

const dirs = new Set();
const outside = [];
for (const path of paths) {
  const slash = path.indexOf('/');
  if (slash <= 0) {
    outside.push(path);
    continue;
  }
  dirs.add(path.slice(0, slash));
}

if (dirs.size > 1) {
  console.error(`✗ 一个 PR 只能改动一个扩展目录，本次改动了 ${dirs.size} 个：${[...dirs].join('、')}`);
  process.exit(1);
}

if (outside.length > 0) {
  console.error(`✗ 改动必须位于扩展目录内，不能直接改根目录文件：${outside.join('、')}`);
  process.exit(1);
}

const dir = [...dirs][0];
if (!existsSync(join(ROOT, dir, 'plugin.json'))) {
  console.error(`✗ ${dir}/ 中没有 plugin.json：新增插件需要它，删除或改名请由维护者操作`);
  process.exit(1);
}

console.log(`✓ 本次只改动扩展目录 ${dir}`);
