# 收录规则

本仓库收录 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 桌宠插件的第三方扩展。每个扩展占一个顶层子目录，收录信息写在目录内的 `plugin.json` 里，根 README 的收录列表由流水线自动生成。

## 提交一个扩展

1. Fork 本仓库并新建分支。
2. 在仓库根新建目录 `<扩展目录>/`，目录名必须等于包名去掉 `dsh-pet-` 前缀（例如包名 `dsh-pet-foo` 对应目录 `foo`）。
3. 按「扩展包要求」放入内容，并提供 `plugin.json`。
4. 提交 PR。PR 会自动校验，不通过时按提示修改即可；合并后收录列表自动更新。

## PR 范围

一个 PR 只能改动**一个扩展目录**，且该目录内必须有 `plugin.json`：

- **新增插件**：新建目录，提 PR；
- **更新插件**：只改该目录内的文件（`lib/`、`assets/`、`plugin.json` 等）；
- **删除或重命名插件**：请开 issue 联系维护者，不要通过 PR 操作。

仓库级文件（`README.md`、`CONTRIBUTING.md`、`scripts/`、`.github/`）不接受 PR 修改。

## 目录结构

```text
petE/
├── README.md
├── CONTRIBUTING.md
└── <扩展目录>/
    ├── plugin.json
    ├── README.md
    ├── package.json
    ├── cordis.patch.yml
    └── lib/
```

## 扩展包要求

| 文件 | 要求 |
| --- | --- |
| `package.json` | 包名以 `dsh-pet-` 开头；声明 `dsh.bundle.patch` 与 `dsh.client`；不得包含 `prepare`、`postinstall` 等生命周期脚本 |
| `cordis.patch.yml` | bundle patch；`insert` 的 entry `id` 与包名一致，且全局唯一 |
| `lib/` | 构建产物，直接提交；不提交 `src/` 或 TypeScript 源码 |
| `plugin.json` | 收录元信息，字段见下 |
| `README.md` | 扩展自己的说明、用法与截图 |

扩展在运行时依赖 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 提供的占用锁与 HTTP 接口，但不需要把它声明为依赖；请在扩展自己的 README 里说明这一点。

## plugin.json

放在扩展目录根，与扩展的 `README.md` 同级。

```json
{
  "name": "dsh-pet-<名字>",
  "description": "一句话说明这个扩展做什么。",
  "install": {
    "cli": "dsh plugin --profile web add \"github:PC2005-cloud/petE#path:/<扩展目录>\"",
    "gui": "github:PC2005-cloud/petE#path:/<扩展目录>"
  },
  "images": [
    "assets/cover.png"
  ]
}
```

| 字段 | 规则 |
| --- | --- |
| `name` | 必填；必须与扩展 `package.json` 的 `name` 完全一致；以 `dsh-pet-` 开头；全仓库唯一 |
| `description` | 必填；非空单行字符串 |
| `install.cli` | 必填；命令行安装命令，去掉命令前缀后必须与 `install.gui` 一致 |
| `install.gui` | 必填；图形化页面中输入的内容，即 `dsh plugin add` 后面的那段 spec |
| `images` | 必填（数组，可为空）；每项为扩展目录内的相对路径（如 `assets/cover.png`），或可直接显示的 `http(s)` 绝对地址 |

安装来源必须是**远端可获取**的形式（npm 包名、GitHub 地址或 tarball 直链），不接受 `link:` 与本地绝对路径。`plugin.json` 不接受未定义的字段。

## 校验项

PR 上自动执行以下检查：

1. `plugin.json` 可解析、字段齐全、无未知字段；
2. `name` 与 `package.json.name` 一致、带 `dsh-pet-` 前缀、全仓库唯一；
3. `install.cli` 去掉命令前缀后与 `install.gui` 完全一致，且 spec 可被解析为 registry、git 或 tarball；
4. 目录名等于 `name` 去掉 `dsh-pet-` 前缀；
5. `package.json` 声明了 `dsh.bundle.patch`，对应文件存在且可解析；声明了 `dsh.client`；存在 `lib/`；无生命周期脚本；
6. `images` 每项有效：相对路径在扩展目录内存在且为图片，或绝对地址可访问且返回图片类型。
