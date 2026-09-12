---
name: dsh-wei-sitecontrol
description: 登记并管理本机用 DSH 搭建的网站/HTTP 服务。当用户新建了一个网站或 HTTP 服务、要求"登记/注册站点"、"把服务记到站点管理里"、"启动/停止/重启某个站"、"看站点日志"、"提交并推送站点代码"、"把站点发布到服务器"时使用本技能。技能依赖 dsh-wei-sitecontrol 插件提供的 site_* 工具。
---

# 站点登记与管理(dsh-wei-sitecontrol)

本技能把"在这台机器上用 DSH 做出来的网站/HTTP 服务"登记进 **dsh-wei-sitecontrol** 插件,之后生命周期、git 与发布都由插件统一管理。

## 何时登记

- 用户刚创建/完成了一个可运行的网站(dev server、静态站、API 服务等);
- 用户说"登记一下这个站""加入站点管理""让它能一键启动/发布";
- 你发现某个工作区里的项目有可用的启动命令(如 `package.json` 的 `dev`/`start` 脚本)且用户打算长期运行它。

**不要**为一次性脚本、单元测试或纯 CLI 工具登记站点。

## 登记前先采集这些事实

1. **workspace**:项目**绝对路径**(不要用相对路径)。
2. **启动命令**:优先读取项目里的 `package.json`(`scripts.dev` / `scripts.start`)、`Makefile`、`docker-compose.yml` 等,选最贴近"长期运行 HTTP 服务"的那条。Windows 下命令由 shell 执行,可直接写 `npm run dev`。
3. **依赖安装命令**:按锁文件判断 —— `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`;`package-lock.json` → `npm ci`;`yarn.lock` → `yarn install --frozen-lockfile`;`requirements.txt` → `pip install -r requirements.txt`。
4. **端口**:从配置里找(如 Vite 的 `server.port`、`.env` 的 `PORT`、`docker-compose` 的端口映射)。取不到就问用户,不要瞎猜后写死。
5. **git 远端与分支**:`git remote -v` 的 HTTPS 地址(内置 git 层**只支持 HTTPS 远端**)与当前分支。
6. **发布目标**:若用户说要发布到服务器,先用 `site_target_list` 看已有目标;没有则用 `site_target_add` 添加(需要 host/user/凭据/远端目录)。

## 登记

调用 `site_register`,把上面采集到的字段一并传入。同一 `name` + `workspace` 重复登记是**更新**,不是重复插入。

```
site_register({
  name: 'my-blog',
  workspace: 'C:\\work\\my-blog',
  command: 'npm run dev',
  port: 5173,
  installCommand: 'npm ci',
  healthPath: '/',
  gitRemote: 'https://github.com/me/my-blog.git',
  gitBranch: 'main',
  deployTargets: 'prod-a',
  autoRestart: true
})
```

登记后用 `site_list` 复核字段是否正确落库。

## 日常操作

| 用户意图 | 使用工具 |
|---|---|
| 看所有站点与状态 | `site_list` |
| 启动 / 停止 / 重启 | `site_start` / `site_stop` / `site_restart` |
| 看日志(可搜索) | `site_logs`(可传 `tail`、`search`) |
| 验证服务是否活着 | `site_health` |
| 看本机负载 / 正在跑什么 | `site_monitor`(CPU/内存/磁盘 + 各站点进程占用 + 任务名字;只要名字,不带进度) |
| 撤销登记 | `site_unregister` |

**排障顺序**:`site_list` 看状态 → `site_logs` 看报错 → 需要时 `site_health` 确认端口/路径是否正确。启动失败最常见的原因是端口被占用或依赖未安装(`installCommand` 没跑过)。

**端口被占用的特殊处理**:若 `site_list` 里某站点显示 `⚠ 端口 X 被 pid Y 占用`,说明启动被插件的前置检查拦下了 —— 这通常是**上一次 DSH 被强制结束**时遗留的孤儿预览进程(站点是 DSH 的子进程)。处理:先 `site_reclaim({ site })` 看它报告的是哪个 pid(不带 `confirm` 只报告、不动手),确认那确实是这个站点的旧进程后,再 `site_reclaim({ site, confirm: true })` 释放端口,然后 `site_start`。**不要**在没看 pid 的情况下直接 confirm。

## 端口冲突与启动失败

插件在 DSH 启动后会自动做一次**遗留进程清理**:DSH 被硬杀(断电、任务管理器、`taskkill /F`)时站点子进程会活下来占着端口,插件会在启动约 1.5 秒后,把**命令行与站点自身命令匹配**的占用进程终止掉。

所以当你看到某站点启动失败并带冲突提示时,含义是:**占用端口的进程不是这个站点的遗留进程**(命令行不匹配),插件按设计没有自动终止它。此时:

1. `site_reclaim({ site })` 先看它报出的 pid 与端口(不带 `confirm` 只报告);
2. 向用户确认那是什么进程(可能是用户自己手动启动的同端口服务);
3. 确认是废弃进程后 `site_reclaim({ site, confirm: true })` 释放,再 `site_start`。

**不要**在没看清 pid 的情况下直接 `confirm`。

## 代码提交

`site_git` 有三个 action:

- `init`:目录还不是 git 仓库时先初始化(内置纯 JS git,无需系统 git;默认分支 `main`)。**登记后若 `site_git` 报"not a git repository",先跑这一步**,它会同时把记录标记为 git 可用;
- `status`:分支、变更文件、与远端的领先/落后;
- `commit`:暂存全部变更并提交(需要 `message` —— 用一句话概括本次改动,风格与仓库历史保持一致);
- `push`:推送到 HTTPS 远端。需要凭据时传 `token`,或在登记时配置 `gitTokenEnv` 指向持有 token 的环境变量。

⚠️ 内置 git 层基于纯 JS 实现,**不支持 SSH 形式的远端**(`git@host:path`)。遇到这种远端时:告知用户把远端改为 `https://…`(配合 token),或改用系统 git 手动推送。不要在失败后反复重试同一个 SSH 远端。

## 发布到服务器

1. `site_target_list` 确认目标存在;没有就用 `site_target_add` 或 `site_target_import` 建立(见下);
2. **先探测**:`site_server_detect({ target })` —— 看服务器上到底有什么(OS/包管理器/httpd/nginx/Tomcat 的 CATALINA_HOME 与 webapps/Docker 与容器/监听端口/候选目录),**并会读服务器配置里的 `<Context docBase>` 得到真正的发布目录**。它会把确认到的结果**写回目标**:回填空的 `uploadDir`/`configFile`/`appHome`/`serviceName`/`serviceKind`,并写入带时间戳的 `verified` 快照。返回里的 `filled` 就是补了什么。**它绝不覆盖你或用户手工设过的值**;
3. **看计划**:`site_deploy_plan({ site, target })`(默认只读探测)→ 逐步确认将执行什么;
4. **预演**:`site_deploy({ site, target, dryRun: true })` 只看本地文件数与远端路径;
5. **正式发布**:`site_deploy({ site, target })`。运行时缺失时不要擅自安装,先向用户说明并征得同意后再传 `allowInstall: true`;
6. 发布完成后核对 `steps` 与脚本输出里的目录列表与监听端口。

**发布前务必先提交代码**(用户通常会期望"提交 + 发布"是一个连贯动作,但两者要在汇报里分开说明)。发布失败时把 `steps` 里失败的那一步原文回报给用户,不要只说"失败了"。

### release 模式与回滚(推荐用于生产)

目标设 `deployMode: 'release'` + `releasesDir` + `configFile` 后,每次发布会新建 `<releasesDir>/<时间戳>` 目录、上传到那里,再改写 `configFile` 里 `contextPath` 的 `docBase` 指向新目录(原配置备份为 `.bak-<时间戳>`),然后重启校验。旧发布留在磁盘上,因此:

- `site_releases({ target })` → 看发布历史与**当前生效目录**;
- `site_rollback({ site, target })` → 切回上一版(或 `to: '<时间戳目录名>'` 指定版本),会先备份配置、改完重启并校验。

**要点**:① 探测给出的 `docBase` 才是发布目录,`uploadDir` 的上一级往往不是;② 找不到匹配 Context 时发布会被中止(这是护栏,别绕过);③ 回滚同样会重启服务,先跟用户说一句。

### 首次配置一台新服务器

**如果用户给了"一台服务器一个目录"的档案(pem + 说明 txt)**,优先用一键导入:

```
site_target_import({ dir: '<工作目录>\\keys\\示例站点' })
```

它会:把 pem 存进保险库(密钥名=目录名)、解析说明里的 ip / ssh 端口 / 描述 / 应用目录 / 发布目录、推断服务类型、把描述写进 `environment`。返回里若出现「⚠ 待补」,说明档案缺项(常见是没写发布目录),需要向用户确认后再补 `uploadDir`。

没有档案目录时手工配置:

```
site_key_add({ name: 'prod', path: 'E:\\keys\\prod.pem' })      # 优先用 path,不要让密钥进对话
site_target_add({
  name: 'prod', host: '<IP>', user: 'root', keyName: 'prod',
  uploadDir: '<探测建议的目录>', serviceKind: 'tomcat',          # static|httpd|nginx|tomcat|docker|custom
  serviceName: 'tomcat9',                                        # 非标准单元名时填
  appHome: '/opt/tomcat9',                         # CATALINA_HOME,生成的启停命令会优先用它
  backup: true, keepReleases: 3
})
site_server_detect({ target: 'prod' })                            # 复核上传目录与服务状态
site_deploy_plan({ site: 'shop', target: 'prod' })                # 给用户看的计划
```

- `uploadDir` 与 `serviceKind` 是这套流程的两个核心参数:前者决定传到哪里,后者决定**怎么停、怎么起**。
- **`uploadDir` 必须对准真正对外提供服务的目录**。Tomcat 常见写法是 `<Context path="/" docBase="/opt/&lt;应用&gt;/ROOT/&lt;应用&gt;"/>` —— 这时上传目录是 `docBase`,不是它的上一级 `ROOT`;传错位置站点不会更新。探测结果里的 `appBase` / `webapps` / `docBase` 要一起看。
- **`restartOnDeploy: false`**:静态内容直接从磁盘提供服务(或 Context 设了 `reloadable="true"` 且只换静态文件)时,发布不需要停/起服务,避免无谓停机;只有替换 class/lib/WAR 才必须重启。
- 目标留空 `stopCommand`/`restartCommand` 时会用内置剧本;服务器环境特殊时用这些字段覆盖。

### 部署脚本(插件存储)

`site_script` 有四个 action:

- `list` / `read`:查看已存脚本;
- `generate`(带 `target`):生成该目标的默认远端脚本(首次发布也会自动生成);
- `save`(带 `name` + `content`):覆盖保存。脚本负责**远端侧**:备份 → 停服务 → 启服务 → 校验;文件传输由插件用 SFTP 完成。用户要求"调整发布步骤"时,改这个脚本而不是改插件代码。

## 安全

- 任何凭据(password / token / passphrase / 私钥)**不要**写进对话正文、日志或 README;工具的返回里也不会包含它们。
- **PEM 密钥的递交方式**:让用户把密钥放到本机某个路径并告诉你路径(`site_key_add` 的 `path` 参数由插件直接读字节),或让用户在面板里上传。**绝不要**请用户把密钥内容粘贴到对话里(会话记录是落盘的)。
- 密钥导入后用返回的**指纹**和用户核对;`site_key_list` 只能看到元数据与指纹,这是设计如此。
- 发布属于"改动远端生产环境"的动作,首次对某台服务器发布前应向用户确认目标与远端目录;`allowInstall` 安装软件包属于更重的一步,必须显式征得同意。
