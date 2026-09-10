# 第三方声明 / Third-party notices

`dsh-wei-sitecontrol` 的代码由 mrwei 编写,采用 MIT 许可(见 `LICENSE`)。

开发过程中**参考**了以下同样以 MIT 许可发布的开源项目(用于理解 DSH 插件形态、客户端 bundle 约定与 SSH 通道用法)。**参考不等于复制**:本插件为独立实现,但按 MIT 的署名惯例在此明确致谢。

| 项目 | 许可 | 参考内容 |
|---|---|---|
| [dsh-farm](https://github.com/MarchLiu/dsh-farm) | MIT | DSH 插件的整体形态:`dsh.bundle.patch` 组合方式、`sidebar.footer.action` + `shell.overlay` 槽位用法、进程监督与 HTTP 路由的组织思路 |
| [flymysql/dsh-remote](https://github.com/flymysql/dsh-remote) | MIT | 基于 ssh2 的远程工作区思路(机器注册表、SFTP 同步、`rw_*` 工具命名) |
| [chai1110/dsh-ssh-remote](https://github.com/chai1110/dsh-ssh-remote) | MIT | 上述项目的多机并行改造,以及"以同名用户 preset 挂载"的适配经验 |

## 运行时依赖

| 包 | 许可 | 用途 |
|---|---|---|
| [ssh2](https://github.com/mscdex/ssh2) | MIT | SSH / SFTP 客户端(连接服务器、上传文件、执行命令) |
| [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) | MIT | 纯 JavaScript git(无需系统 git 即可 status/commit/push) |

## DeepSeek Harness

本插件运行于 DeepSeek Harness(`@deepseek-ai/dsh`,MIT)之上,但与该项目的官方发布无隶属关系;插件中的问题请向本插件仓库反馈。
