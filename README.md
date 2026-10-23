# petE

[![Stars](https://img.shields.io/github/stars/PC2005-cloud/petE?style=flat-square&logo=github)](https://github.com/PC2005-cloud/petE/stargazers)
[![Forks](https://img.shields.io/github/forks/PC2005-cloud/petE?style=flat-square&logo=github)](https://github.com/PC2005-cloud/petE/forks)
[![Pull requests](https://img.shields.io/github/issues-pr/PC2005-cloud/petE?style=flat-square&logo=github)](https://github.com/PC2005-cloud/petE/pulls)
[![Issues](https://img.shields.io/github/issues/PC2005-cloud/petE?style=flat-square&logo=github)](https://github.com/PC2005-cloud/petE/issues)
[![Contributors](https://img.shields.io/github/contributors/PC2005-cloud/petE?style=flat-square&logo=github)](https://github.com/PC2005-cloud/petE/graphs/contributors)
[![Last commit](https://img.shields.io/github/last-commit/PC2005-cloud/petE?style=flat-square&logo=github)](https://github.com/PC2005-cloud/petE/commits/main)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](CONTRIBUTING.md)

**dsh-pet 的第三方扩展收录仓库。**

[dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 是 DSH（DeepSeek Harness）的桌宠插件：一行命令装好，界面里就多一只透明动画小桌宠，能多开、能调大小位置，还能用 AI 视频自己做素材。

这个仓库把大家给它做的扩展收在一起——会吃白饭的、会打瞌睡的、会跟着鼠标跑的。你可以来挑一个装上，也可以把自己做的提交进来。

每个扩展占一个目录，收录信息写在目录里的 `plugin.json`；下面的列表由流水线从这些文件生成，不用手工维护。

## 收录列表

> 由流水线根据各扩展的 `plugin.json` 生成，请勿手工编辑。

<!-- plugins:start -->

### dsh-pet-baifan

右键桌宠，跑到屏幕底部，追着吃白饭。

![dsh-pet-baifan 1](baifan/assets/preview/cover.png)

![dsh-pet-baifan 2](baifan/assets/preview/running.png)

```powershell
dsh plugin --profile web add "github:PC2005-cloud/petE#path:/baifan"
```

图形化页面粘贴：`github:PC2005-cloud/petE#path:/baifan`

### dsh-pet-fish-day

按一天的日程推演：复用 dsh-pet 现有动画，按时段播放不同的动作、气泡与位置。

```powershell
dsh plugin --profile web add "github:PC2005-cloud/petE#path:/fish-day"
```

图形化页面粘贴：`github:PC2005-cloud/petE#path:/fish-day`

<!-- plugins:end -->

## 安装一个扩展

还没装 dsh-pet 的话，先按 [它的 README](https://github.com/PC2005-cloud/dsh-pet) 装好——所有扩展都跑在它上面。

```powershell
dsh plugin --profile web add "github:PC2005-cloud/petE#path:/<扩展目录>"
```

也可以走图形化：DSH Web → 侧栏「插件」→「添加插件」，粘贴同样的地址：

```text
github:PC2005-cloud/petE#path:/<扩展目录>
```

`<扩展目录>` 是扩展的目录名，即包名去掉 `dsh-pet-` 前缀。安装前请确认 `dsh-pet` 已在同一个 profile 里启用。

## 想把自己的扩展放进来？

欢迎。收录规则、目录结构、`plugin.json` 字段和 PR 校验项都写在 [CONTRIBUTING.md](CONTRIBUTING.md) 里。

## 说明

- 各扩展的代码与素材归其作者所有；
- 收录不代表对功能或安全性的审核，安装前请自行阅读代码。
