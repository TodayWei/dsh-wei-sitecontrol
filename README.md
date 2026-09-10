# dsh-wei-sitecontrol

DSH 插件:把**在这台机器上用 DSH 做出来的网站 / HTTP 服务**登记成一份带依赖信息的注册表,然后在 DSH 里统一管理它们的**生命周期、git 提交与 SSH 发布**。

- 🧭 侧栏入口 + 管理面板(列表、状态、启停、日志、git、发布)
- 🤖 给 Agent 的 `site_*` 工具 + 一份登记技能(`skill/SKILL.md`)
- 🗄️ 注册表落盘 `$DSH_HOME/storages/dsh-wei-sitecontrol/registry.json`
- 🔧 内置纯 JS git(`isomorphic-git`,无需系统 git)与 SSH 发布(`ssh2`)

## 双半结构

| 半边 | 文件 | 职责 |
|---|---|---|
| Host | `index.js` + `lib/*` | 站点注册表、进程监督(启停/日志/健康检查)、git 层、SSH 发布层、`/dsh-wei-sitecontrol` HTTP API、`site_*` 工具 |
| Client | `client.js` | 侧栏底部入口(`sidebar.footer.action`)+ 管理面板(`shell.overlay`),通过同源 `/dsh-wei-sitecontrol` API 与 Host 通信 |

`lib/` 分工:`registry.js`(数据模型 + 持久化 + 脱敏)、`lifecycle.js`(进程监督)、`gitops.js`(git)、`deploy.js`(SSH 发布)。

## 安装

### 方式 A:从发布包安装(推荐给其他人)

```powershell
# 1) 在 profile 下安装插件包(会一并解析 ssh2 / isomorphic-git 依赖)
dsh plugin --profile web add <路径>\dsh-wei-sitecontrol-0.1.0.tgz
#    等价于在 %USERPROFILE%\.dsh\profiles\web 目录里 npm install 这个 tgz

# 2) 把插件行插入 profile 组合(见 cordis.patch.yml)
#    编辑 %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml,追加:
#    - insert:
#        - id: wei-sitecontrol
#          name: dsh-wei-sitecontrol

# 3) 登记技能(可被 Agent 自动发现)
#    复制 skill/SKILL.md → %USERPROFILE%\.dsh\skills\dsh-wei-sitecontrol\SKILL.md

# 4) 重启 dsh web
```

### 方式 B:从源码目录安装(开发者)

```powershell
cd <插件目录>; npm install
# 让 profile 能解析裸包名(Windows 用 junction,等价于 ln -s)
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-wei-sitecontrol" "<插件目录绝对路径>"
# 然后同上第 2~4 步
```

### 数据与卸载

- 注册表、密钥保险库、部署脚本、日志都在 `$DSH_HOME/storages/dsh-wei-sitecontrol/`
- 密钥文件权限:POSIX `600` / Windows ACL 仅当前用户;插件**从不**通过 API、工具或日志返回密钥内容(只给指纹)
- 卸载:删 profile patch 里的插件行 → 删 `node_modules` 里的链接 → 可选删除上述数据目录
- 插件卸载(DSH 关闭 / profile 重载)时会停止它启动的所有站点子进程,并释放路由与定时器(有回归测试锁定)

## HTTP API

前缀 `/dsh-wei-sitecontrol`(与 DSH Web 同端口):

| 方法与路径 | 说明 |
|---|---|
| `GET /sites` | 站点列表(含运行状态) |
| `POST /sites` | 登记或更新站点 |
| `DELETE /sites/<id>` | 删除站点(运行中会先停止) |
| `POST /sites/<id>/start\|stop\|restart` | 生命周期 |
| `GET /sites/<id>/logs?tail=&search=` | 日志(内存环 + 落盘日志) |
| `GET /sites/<id>/health` | HTTP 健康探测 |
| `POST /sites/<id>/reclaim` | 端口被占用(孤儿进程)时释放 `{ confirm: true }` |
| `POST /sites/<id>/git/init` | 目录还不是仓库时初始化(默认分支 `main`,幂等) |
| `GET /sites/<id>/git/status` | 分支/变更/领先落后/最近提交 |
| `POST /sites/<id>/git/commit` | 暂存全部并提交 `{ message }` |
| `POST /sites/<id>/git/push` | 推送 `{ remote?, branch?, token? }` |
| `POST /sites/<id>/deploy` | 发布 `{ target, dryRun?, allowInstall?, overrides? }` |
| `POST /sites/<id>/deploy-plan` | 预览发布计划 `{ target, detect? }`(detect 默认 true,只读探测服务器) |
| `GET/POST /targets`,`DELETE /targets/<name>`,`POST /targets/<name>/ping`,`POST /targets/<name>/detect` | 发布目标管理、连通性测试与环境探测 |
| `GET /keys`,`POST /keys`,`DELETE /keys/<name>` | 密钥保险库(只返回元数据与指纹) |
| `POST /targets/import` | 从"一台服务器一个目录"的档案(pem + 说明)一键建档 |
| `POST /targets/<name>/provision` | **描述驱动建档**:`{ text, user?, discover? }` → 解析描述 + 连服务器读配置 + 回填发布字段 |
| `GET /scripts`,`GET /scripts/<name>`,`POST /scripts`,`DELETE /scripts/<name>` | 部署脚本仓库 |
| `GET /schedules`,`POST /schedules`,`DELETE /schedules/<id>` | 定时发布排期(入库、重启后自动恢复) |
| `GET /sites/<id>/releases?target=`,`POST /sites/<id>/rollback` | release 模式的发布历史与回滚 |
| `GET /status` | 站点数与运行中数量(面板徽标用) |

## SSH 部署

### 描述驱动建档(推荐入口)

不用手填一堆字段:把环境说明**整段文本**交给插件即可。文本存在 `envText`(数据库里),目录只需要 pem。

```powershell
# 面板:目标区最上方「环境描述」文本框 → 「按描述建档并连服务器确认」
POST /targets/<name>/provision { "text": "ip:203.0.113.10\nssh端口:TCP:22\n描述：…使用tomcat服务，tomcat应用目录在：/opt/tomcat9。程序发布目录在/srv/www。", "user": "root" }
```

执行顺序:**解析文本**(ip / ssh 端口 / 描述 / 应用目录 / 发布目录 / 服务类型 / 单元名;Tomcat 描述会自动推出 `configFile` 与 `releasesDir`,并选 `deployMode: release`)→ **立即入库**(SSH 失败也不丢)→ **连服务器读它自己的配置**(`<Context docBase>` / nginx `root` / `DocumentRoot`)→ **用服务器真相覆盖推断值** → 写回全部发布字段 + 带时间戳的 `verified` 快照。

- `envText` 是**权威来源**;`environment` 是它解析出的描述行,面板同时展示两者
- `POST /targets` 是 **PATCH 语义**:只发 `{name, envText}` 不会动其它字段(已有测试锁定)
- Agent 侧同名工具:`site_target_provision`

### 定时发布

```
POST /schedules { site, target, at, note }   → 排期入库(记录在 registry.json)
GET  /schedules                              → pending / running / done / failed / cancelled
DELETE /schedules/<id>                       → 取消(pending 才可取消)
```

到点执行的**与手动发布完全同一条代码路径**,并把每步结果(含失败步骤名)写回排期记录;DSH 重启后启动时重新装订所有 pending 排期,长时间等待自动续订。面板上可用 `datetime-local` 直接设定。Agent 工具:`site_schedule_publish` / `site_schedule_list` / `site_schedule_cancel`。

### 密钥保险库

```powershell
# 从本机已有文件导入(推荐:内容不进对话、不进日志)
POST /keys  { "name": "prod", "path": "E:\\keys\\prod.pem" }
# 面板上传路径(content 直传,同样只回元数据)
POST /keys  { "name": "prod", "content": "-----BEGIN RSA PRIVATE KEY-----\n..." }
```

- 落盘位置:`<dataDir>/keys/<name>.pem`,**POSIX 600 / Windows ACL 仅当前用户**(目录同样收紧)
- **密钥内容永不出现在任何 API、工具或日志输出中**,只有元数据:`bytes`、`uploadedAt`、`keyType`、`encrypted`、**`fingerprint`(ssh-keygen 风格的 `SHA256:…`)**、`warning`
- 导入即校验:非 PEM 拒绝、无法解析拒绝、密钥名禁止路径穿越、重复导入需显式 `overwrite`
- **PKCS#8 提示**:内置 SSH 客户端(`ssh2`)不支持 `-----BEGIN PRIVATE KEY-----`(PKCS#8)。这类密钥会被**接受并标记 `warning`**,请先转换:`ssh-keygen -p -m PEM -f key.pem`(AWS 的 `.pem` 通常是 PKCS#1,可直接用)
- 加密私钥(带 passphrase)可以导入,此时不计算指纹

### 目标服务器字段

| 字段 | 说明 |
|---|---|
| `host` / `port` / `user` | SSH 地址与账号 |
| `keyName` | 保险库密钥名(**首选凭据**);也可用 `privateKeyPath`(本机文件)或 `password` |
| **`uploadDir`** | **上传目录**(如 `/srv/www/site`、`/opt/tomcat9/webapps/site`);也可由探测建议 |
| **`serviceKind`** | `static` / `httpd` / `nginx` / `tomcat` / `docker` / `custom`,决定停止与启动方式 |
| `serviceName` | 非标准单元名或容器名(如 `tomcat9`) |
| `appHome` | 运行时目录(如 Tomcat 的 `CATALINA_HOME`),生成的启停命令会优先用它 |
| `environment` | 环境/用途描述(通常由档案导入填入,面板与 Agent 都会看到) |
| `sourceDir` | 该目标的凭据/说明来自哪个档案目录(便于回头核对) |
| `restartOnDeploy` | 发布时是否停止/重启服务(**默认 true**)。静态内容直接从磁盘提供服务时可设 false,避免停机 |
| `deployMode` | `inplace`(默认,直接覆盖 `uploadDir`)或 **`release`**(每次发布到新时间戳目录再切换配置,可回滚) |
| `releasesDir` | release 模式:发布目录的父目录(如 `/opt/releases`) |
| `configFile` | release 模式:要改写 docBase 的配置文件(如 Tomcat 的 `conf/server.xml`) |
| `contextPath` | release 模式:要切换的 Context 路径,默认 `/` |
| `verified` | **探测落库的快照(只读)**:时间戳、系统、各服务是否存在、Tomcat home/unit/appBase、**服务器配置里的发布目标 docBase**、监听端口 |
| `installCommand` / `stopCommand` / `startCommand` / `restartCommand` | 覆盖该服务类型的默认命令(留空则用内置剧本) |
| `backup` / `backupDir` / `keepReleases` | 是否备份(默认**开**)、备份目录(默认 `<uploadDir>.bak`)、保留份数(默认 3) |
| `scriptName` | 关联的部署脚本名(默认 `<目标名>-deploy`) |

### 服务器档案一键导入(一个目录一台服务器)

约定目录结构(与 `<workspace>\keys\` 一致):

```
keys/<服务器名>/
  <服务器名>.pem      私钥(导入保险库,内容不外显)
  hostreadme.txt      ip / ssh端口 / 描述 / 应用目录 / 发布目录(UTF-8 或 GBK 都能读)
```

```powershell
POST /targets/import  { "dir": "E:\\<工作目录>\\keys\\示例站点" }
# 或让 Agent 执行:site_target_import({ dir: "E:\\<工作目录>\\keys\\示例站点" })
```

一次完成:私钥入保险库(以目录名为密钥名)、解析说明里的 ip 与 ssh 端口、推断服务类型(tomcat/nginx/httpd/docker/static)、取出**应用目录(CATALINA_HOME)**与**发布目录**,并把描述写入 `environment`。解析不到的项会在返回里以「待补」列出,**不会**自动上传或执行任何远端操作。

支持的中文/英文标签(大小写不敏感):`ip:` / `host:` · `ssh端口:` / `ssh port:` · `描述:` / `说明:` / `环境:` · `程序发布目录在…` / `发布目录:` / `publish dir:` · `tomcat应用目录在…` / `CATALINA_HOME:`

### 探测会把确认到的环境写回目标

`POST /targets/<name>/detect`(工具 `site_server_detect`)不只是看一眼——它会:

1. **读服务器自己的配置**:Tomcat 的 `<Context path="/" docBase="…">`、nginx 的 `root`、httpd 的 `DocumentRoot`,从而得到**真正的发布目录**,而不是靠猜;
2. **回填为空的发布字段**:`uploadDir`(来自 docBase/root)、`configFile`、`appHome`(CATALINA_HOME)、`serviceName`(systemd 单元名)、`serviceKind`;
3. **写入 `verified` 快照**(带时间戳),后续任何时候都能在面板/工具里看到"上次确认的服务器环境是什么";
4. **绝不覆盖手工设过的值** —— 显式配置永远优先;要只读探测可传 `persist: false`。

返回里的 `filled` 数组就是本次自动补齐了什么(面板会显示成「本次自动补齐:…」)。

### release 模式:新目录 + 配置切换(可回滚)

```
collect → connect → detect → mkdir <releasesDir>/<YYYYMMDD-HHMMSS> → upload 到该目录
        → 读 configFile → 改写 contextPath 的 docBase → 备份配置 .bak-<时间戳>
        → 新配置写到 .new-<时间戳> 再 mv 原子覆盖 → restart → curl 校验 → 清理旧发布(保留 N 份)
```

为什么值得:覆盖式发布没有回滚,而回滚在出问题时就是一切。

- **护栏**:找不到匹配的 Context 就**拒绝改写并中止**(绝不猜、绝不盲改);配置先备份;新配置走临时文件 + `mv` 原子替换;每步都有报告
- **无中断**:文件先上传到新目录,配置切换前线上仍在跑旧版本;只有 restart 那一下有短暂停机(若 `restartOnDeploy: false` 且 Context `reloadable="true"`,连停机都没有)
- **回滚**:`site_releases` 看历史(含当前生效目录),`site_rollback` 切回上一版(或不指定时自动选上一版),同样先备份配置、改完重启并校验
- 旧发布目录**留在磁盘上**直到被 `keepReleases` 清理,所以回滚随时可用

### 发布流程

```
collect → connect → detect → resolve uploadDir → (install) → script → upload(SFTP) → run script → verify
```

- **detect**:一条复合探测命令,取回 OS/包管理器、`httpd|apache2` 及配置目录、`nginx`、**Tomcat 的 `CATALINA_HOME`/`conf/server.xml`/`webapps`**、Docker 版本与运行中容器、相关 systemd 单元、监听端口、候选站点目录
- **install**:仅当运行时缺失**且**显式传 `allowInstall: true` 时才执行安装命令(例如 `yum install -y httpd`)
- **script**:发布脚本存在 `<dataDir>/scripts/<name>.sh`,**首次发布自动生成**、之后可编辑;经 `bash -s` 由标准输入执行,**远端不留脚本文件**。脚本负责远端侧:备份(保留 N 份并清理旧的)→ 停止服务 → (文件已由 SFTP 上传)→ 启动服务 → 校验(列目录 + 列监听端口)
- 文件传输由 Node 侧 SFTP 完成,排除 `node_modules/`、`.git/`、缓存目录等;站点可用 `exclude` 追加

### 相关工具

`site_key_add` · `site_key_list` · `site_key_remove` · `site_target_add` · `site_target_list` · `site_server_detect` · `site_deploy_plan` · `site_deploy` · `site_script`


## 数据契约(面板与 Agent 共同依赖)

`Site.status.state` 的 6 个取值(面板按此上色):

| 取值 | 含义 |
|---|---|
| `stopped` | 未运行(含正常退出) |
| `starting` | 已 spawn,尚未确认可用 |
| `running` | 子进程存活 |
| `unhealthy` | 进程在,但健康探测判定异常 |
| `stopping` | 已发出停止信号,等待退出 |
| `failed` | 非零退出、spawn 失败或探测判定失败 |

- `GET /status` 的 `running` 计数 = `running | starting | unhealthy`(与监督器的 live 定义一致)
- `GET /sites/<id>/health` 在失败时除 `{ ok, status, ms, url }` 外还会带 `error`(`no port or url configured` / `timeout` / 异常信息)
- `POST /sites/<id>/git/push` 的 `token` 可省略:此时回落到站点配置的 `gitTokenEnv` 指向的环境变量;两者都没有时,私有 HTTPS 远端会推送失败(面板**不采集也不发送任何密钥**)
- `POST /sites` 登记**新站点**必须显式给出 `workspace` 绝对路径,否则返回 400(避免默认落到 DSH 进程工作目录而污染 `name+workspace` 幂等键);携带 `id` 的更新请求可省略

## 配置(插件行 `config`)

| 字段 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/storages/dsh-wei-sitecontrol` | 注册表与日志目录 |
| `ringLines` | `5000` | 每个站点内存日志行数上限 |
| `stopGraceMs` | `3000` | 停止时的宽限期 |
| `autoReclaimOrphans` | `true` | 启动时自动清理"命令行与站点自身命令匹配"的遗留进程(见下) |
| `gitAuthorName` / `gitAuthorEmail` | `DSH Site Manager` / `site-manager@localhost` | 内置 git 的提交作者 |

### 启动时的孤儿清理(`autoReclaimOrphans`)

站点是 DSH 的子进程,正常关闭时会被干净停掉。但 DSH 被**硬杀**(断电、任务管理器结束任务、`taskkill /F`)时没有任何机会执行清理,站点进程就会活下来继续占着端口,导致下次启动失败。

所以插件在启动约 1.5 秒后会做一次清扫,判据**严格且保守**:

1. 只看**已登记站点的端口**;
2. 取出占用者的命令行,**必须与站点自身的命令匹配**(命令里的脚本名/端口号等特征 token 全部出现);
3. 命中才终止(Windows `taskkill /T /F`);
4. **不匹配的进程绝不碰**,只记录为冲突(`status.conflict.foreign = true`)并在站点日志里写明占用 pid 与命令行,由面板显示红字提示,由人决定是否点「释放端口」。

以下情况一律不杀:命令行含 `@deepseek-ai/dsh` 或 `lib/bin.js`(harness 自身)、命令行读不出来、站点没有端口、执行清扫的是 DSH 自己的 pid。

想让插件完全不碰进程,把该字段设为 `false`,改用面板的「释放端口」按钮或 `site_reclaim` 工具手动处理。

## 已知限制

- **内置 git 只支持 HTTP(S) 远端**:`git@host:path` 这类 SSH 远端无法推送(isomorphic-git 不支持 SSH 传输)。本地 `status`/`commit` 不受影响。要推 SSH 远端请改为 HTTPS + token,或改用系统 git。
- **内置 git 的 HTTP 传输是本插件自己实现的**(`lib/githttp.js`),因为 isomorphic-git 自带的 Node 客户端有两个坑:①它内部用 `simple-get`,而 Node 19+ 的默认连接池是 `keepAlive + timeout:5000` —— 服务器沉默 5 秒(推送到 GitHub 时 `receive-pack` 处理包就会这样)就报出与真实原因无关的 `Request timed out`;②Node 的 `http(s).request` 不读 Windows 系统代理,在需要代理的网络里直连会 `connect ETIMEDOUT`。现在:自管连接与超时,直连失败自动改走 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` 或探测到的本地代理(`127.0.0.1:7890` 等)的 CONNECT 隧道,而 `127.*` / `192.168.*` / `10.*` / `172.16-31.*` 与 `NO_PROXY` 命中的地址始终直连(局域网 git 服务器不会绕远路)。
- **站点是本 DSH 进程的子进程**:DSH 退出时会被回收;需要长期守护请交给 systemd/pm2 等,再用本插件做登记与发布。
- **Windows 停止方式**为 `taskkill /T /F`(强制),POSIX 为进程组 `SIGTERM` → `SIGKILL`。
- 密钥与密码只存本机注册表(`registry.json`),API 与工具返回中一律脱敏。
