#!/usr/bin/env node
/**
 * 根据各扩展目录的 plugin.json 生成根 README 的收录列表。
 *
 * 用法：
 *   node scripts/render-readme.mjs           写入 README.md
 *   node scripts/render-readme.mjs --check   只比对，不写入（不一致时退出码 1）
 *
 * 列表位于 <!-- plugins:start --> 与 <!-- plugins:end --> 之间；
 * 区块外的内容原样保留。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(ROOT, 'README.md');
const START = '<!-- plugins:start -->';
const END = '<!-- plugins:end -->';
const EMPTY = '还没有收录任何扩展，欢迎提交第一个。';
const SKIP = new Set(['.git', '.github', 'scripts', 'docs', 'node_modules']);

/** 读取所有插件的 plugin.json，按 name 排序。 */
async function loadPlugins() {
  const entries = await readdir(ROOT, { withFileTypes: true });
  const plugins = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(ROOT, entry.name, 'plugin.json'), 'utf8'));
    } catch {
      continue;
    }
    plugins.push({ dir: entry.name, ...manifest });
  }
  return plugins.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** 生成某个插件的区块。 */
function renderPlugin(plugin) {
  const lines = [`### ${plugin.name}`, '', plugin.description];

  const images = Array.isArray(plugin.images) ? plugin.images : [];
  for (const [index, image] of images.entries()) {
    const src = /^https?:\/\//i.test(image) ? image : `${plugin.dir}/${image.replace(/^\.\//, '')}`;
    lines.push('', `![${plugin.name} ${index + 1}](${src})`);
  }

  lines.push(
    '',
    '```powershell',
    plugin.install.cli,
    '```',
    '',
    `图形化页面粘贴：\`${plugin.install.gui}\``,
  );
  return lines.join('\n');
}

const plugins = await loadPlugins();
const body = plugins.length === 0 ? EMPTY : plugins.map(renderPlugin).join('\n\n');

const readme = await readFile(README, 'utf8');
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start === -1 || end === -1 || end < start) {
  console.error(`✗ README.md 缺少 ${START} / ${END} 标记`);
  process.exit(1);
}

const expected = `${readme.slice(0, start + START.length)}\n\n${body}\n\n${readme.slice(end)}`;
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  if (readme !== expected) {
    console.error('✗ README.md 的收录列表不是最新的，运行 node scripts/render-readme.mjs 重新生成');
    process.exit(1);
  }
  console.log('✓ README.md 的收录列表已是最新。');
} else if (readme === expected) {
  console.log('✓ README.md 无变化。');
} else {
  await writeFile(README, expected, 'utf8');
  console.log(`✓ 已更新 README.md（${plugins.length} 个扩展）。`);
}
