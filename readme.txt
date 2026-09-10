================================================================================
 dsh-wei-sitecontrol —— DSH 站点控制器
 Site Controller for DeepSeek Harness
--------------------------------------------------------------------------------
 作者 Author : mrwei <10000715@qq.com>
 许可 License: MIT
 仓库 Repo   : https://github.com/TodayWei/dsh-wei-sitecontrol
================================================================================

本文件包含两个完整版本 / This file contains two complete versions:

  【中文版】 见下方「一、中文文档」          (Chinese, starts right below)
  【English】 see "PART 2 - ENGLISH DOCS"  (English, second half of this file)


================================================================================
 一、中文文档
================================================================================

1. 这是什么
--------------------------------------------------------------------------------
把「在这台机器上用 DSH 做出来的网站 / HTTP 服务」登记成一份带依赖信息的注册表,
然后在 DSH 里统一管理它们的生命周期、git 提交与 SSH 发布。

一句话:DSH 里长出来的站点,从「跑起来」到「上线到服务器」,都在一个面板里管。

2. 功能特性
--------------------------------------------------------------------------------
  * 侧栏入口 + 管理面板:站点列表、运行状态、启停、日志、git、发布,
    入口是侧栏底部的一个向右三角 ▶ 站点控制器(与「设置」同级)。
  * 给 Agent 的工具:一整套 site_* 工具(登记、启停、日志、健康、git、发布、
    探测、排期、回滚……),Agent 可以直接替你做完整流程。
  * 内置登记技能:skill/SKILL.md,复制到 ~/.dsh/skills 后 Agent 能自动发现。
  * 进程监督:启动/停止/重启、内存日志环(默认 5000 行)+ 落盘日志、
    HTTP 健康探测、端口被孤儿进程占用时的「释放端口」。
  * 内置纯 JS git(isomorphic-git):不需要系统装 git 就能 status / commit / push。
  * SSH 发布(ssh2):连通性测试、服务器环境探测、部署脚本入库、
    定时发布、release 模式发布与一键回滚。
  * 密钥保险库:私钥只存本机,只返回元数据与 SHA256 指纹,内容永不出现在
    任何 API、工具或日志输出里。

3. 环境要求
--------------------------------------------------------------------------------
  * DeepSeek Harness(web profile),已测试 0.1.1-rc.2 / 0.1.2-rc.1
  * Node.js >= 20
  * 依赖:ssh2、isomorphic-git(安装插件包时会自动装上)

4. 安装
--------------------------------------------------------------------------------
方式 A:从发布包安装(推荐给其他人)

    # 1) 在 profile 下安装插件包(会一并解析 ssh2 / isomorphic-git 依赖)
    dsh plugin --profile web add <路径>\dsh-wei-sitecontrol-0.1.0.tgz

    # 2) 把插件行插入 profile 组合
    #    编辑 %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml,追加:
    #      - insert:
    #          - id: wei-sitecontrol
    #            name: dsh-wei-sitecontrol

    # 3) 登记技能(可选,但建议:Agent 才能自动发现)
    #    复制 skill/SKILL.md 到 %USERPROFILE%\.dsh\skills\dsh-wei-sitecontrol\SKILL.md

    # 4) 重启 dsh web

方式 B:从源码目录安装(开发者)

    cd <插件目录>
    npm install
    # 让 profile 能解析裸包名(Windows 用 junction,等价于 Linux 的 ln -s)
    cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-wei-sitecontrol" "<插件目录绝对路径>"
    # 然后同上第 2~4 步

方式 C:已发布到 npm 后

    dsh plugin --profile web add dsh-wei-sitecontrol

5. 快速开始
--------------------------------------------------------------------------------
  1) 启动 DSH Web(dsh web),用浏览器打开它的地址。
  2) 看侧栏底部:▶ 站点控制器 —— 点开管理面板。
  3) 在面板登记一个站点:名称、工作目录(workspace 绝对路径)、启动命令、
     端口、健康检查路径。
  4) 「启动」→ 状态灯变绿;「日志」看输出;「健康」做一次 HTTP 探测;
     「Git」提交/推送;「发布」预览计划并发布到服务器。

6. 数据位置与安全
--------------------------------------------------------------------------------
  * 注册表 / 密钥 / 部署脚本 / 日志都在:$DSH_HOME/storages/dsh-wei-sitecontrol/
      registry.json      站点与发布目标注册表(密钥内容不在这里,只有文件名)
      keys/<名字>.pem    私钥,权限 POSIX 600 / Windows ACL 仅当前用户
      scripts/<名字>.sh  远端部署脚本(经 bash -s 由标准输入执行,远端不留文件)
      logs/              各站点落盘日志
  * 私钥导入即校验:非 PEM 拒绝、无法解析拒绝、密钥名禁止路径穿越、
    重复导入需显式 overwrite;返回只有 bytes / uploadedAt / keyType /
    encrypted / fingerprint(SHA256:…) / warning。
  * 注意:ssh2 不支持 PKCS#8(BEGIN PRIVATE KEY),这类密钥会被接受并标记
    warning,请先转换:ssh-keygen -p -m PEM -f key.pem
  * 卸载:删 profile patch 里的插件行 → 删 node_modules 里的链接 →
    (可选)删数据目录。插件卸载时会停止它启动的所有站点子进程并释放
    路由与定时器。

7. SSH 发布
--------------------------------------------------------------------------------
  * 描述驱动建档(推荐入口):把环境说明整段文本交给插件,例如
      "ip:203.0.113.10 / ssh端口:TCP:22 / 描述:公司官网,使用 tomcat,
       tomcat 应用目录在 /opt/tomcat9,程序发布目录在 /srv/www"
    插件会解析出 ip、端口、服务类型、应用目录、发布目录,先入库(SSH 失败也
    不丢),再连服务器读它自己的配置(Context docBase / nginx root /
    DocumentRoot),用服务器真相覆盖推断值,并写入带时间戳的 verified 快照。
  * release 模式(推荐,可回滚):
      collect → connect → detect → mkdir <releasesDir>/<YYYYMMDD-HHMMSS>
      → 上传到新目录 → 读 config 改写 docBase → 备份配置 .bak-<时间戳>
      → 新配置写临时文件再 mv 原子覆盖 → restart → curl 校验
      → 清理旧发布(保留 N 份)
    旧发布目录留在磁盘上直到被 keepReleases 清理,所以回滚随时可用;
    找不到匹配的 Context 会「拒绝改写并中止」——绝不猜、绝不盲改。
  * 回滚:面板的发布历史里点回滚,或让 Agent 调用 site_rollback。
  * 定时发布:设定时间入库,DSH 重启后自动恢复;到点执行与手动发布
    完全同一条代码路径,每步结果(含失败步骤)写回排期记录。

8. 已知限制
--------------------------------------------------------------------------------
  * 内置 git 只支持 HTTP(S) 远端;git@host:path 这类 SSH 远端无法推送
    (isomorphic-git 不支持 SSH 传输)。本地 status/commit 不受影响。
  * 内置 git 的 HTTP 传输是本插件自己实现的(lib/githttp.js),因为
    isomorphic-git 自带的 Node 客户端有两个坑:① 它内部用 simple-get,
    而 Node 19+ 默认连接池是 keepAlive + timeout:5000,服务器沉默 5 秒
    (推送到 GitHub 时 receive-pack 处理包就会这样)就报出与真实原因无关的
    "Request timed out";② Node 的 http(s).request 不读 Windows 系统代理,
    在需要代理的网络里直连会 connect ETIMEDOUT。
    现在的行为:自管连接与空闲超时;直连失败自动改走 HTTPS_PROXY /
    HTTP_PROXY / ALL_PROXY 或探测到的本地代理(127.0.0.1:7890 等)的
    CONNECT 隧道;而 127.* / 192.168.* / 10.* / 172.16-31.* 与 NO_PROXY
    命中的地址始终直连(局域网 git 服务器不会绕远路)。
  * 站点是本 DSH 进程的子进程:DSH 退出时会被回收。需要长期守护请交给
    systemd / pm2 等,再用本插件做登记与发布。
  * Windows 停止方式为 taskkill /T /F;POSIX 为进程组 SIGTERM → SIGKILL。
  * 未配置健康检查路径时,「健康」探测只能判定进程存活。

9. 致谢与许可
--------------------------------------------------------------------------------
  * 许可:MIT,见 LICENSE。
  * 参考过的同许可(MIT)开源项目:见 THIRD_PARTY_NOTICES.md
    (dsh-farm、dsh-remote、dsh-ssh-remote)。
  * 运行于 DeepSeek Harness(@deepseek-ai/dsh,MIT)之上,但与该项目的
    官方发布无隶属关系;插件相关问题请向本插件仓库反馈。


================================================================================
 PART 2 - ENGLISH DOCS
================================================================================

1. What it is
--------------------------------------------------------------------------------
Registers every website / HTTP service you build with DSH on this machine into a
single registry that keeps the details needed to run it, then manages their
lifecycle, git history and SSH deploys from inside DSH.

In one line: sites born in DSH are managed in one panel, from "it runs" to
"it is live on the server".

2. Features
--------------------------------------------------------------------------------
  * Sidebar entry + panel: site list, live status, start/stop, logs, git and
    deploy. The entry is a right-pointing triangle (>) labelled "Site Control"
    at the bottom of the sidebar, next to "Settings".
  * Agent tools: a full set of site_* tools (register, start/stop, logs,
    health, git, deploy, server detect, schedule, rollback, ...), so an agent
    can drive the whole workflow for you.
  * Bundled skill: skill/SKILL.md - copy it into ~/.dsh/skills and the agent
    discovers it automatically.
  * Process supervision: start / stop / restart, in-memory log ring (5000 lines
    by default) plus on-disk logs, HTTP health checks, and a "reclaim port"
    action for orphan processes holding a site port.
  * Built-in pure-JS git (isomorphic-git): status / commit / push without a
    system git installation.
  * SSH deploys (ssh2): connectivity test, server environment probing, stored
    deploy scripts, scheduled publishing, release-mode deploys and one-click
    rollback.
  * Key vault: private keys stay on this machine; only metadata and an SHA256
    fingerprint are ever returned. Key material never appears in any API
    response, tool result or log line.

3. Requirements
--------------------------------------------------------------------------------
  * DeepSeek Harness (web profile); tested with 0.1.1-rc.2 and 0.1.2-rc.1
  * Node.js >= 20
  * Dependencies: ssh2, isomorphic-git (installed with the plugin package)

4. Installation
--------------------------------------------------------------------------------
Option A - from the release tarball (recommended for other users)

    # 1) install the tarball into your profile (pulls ssh2 / isomorphic-git)
    dsh plugin --profile web add <path>\dsh-wei-sitecontrol-0.1.0.tgz

    # 2) add the plugin row to the profile composition
    #    edit %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml and append:
    #      - insert:
    #          - id: wei-sitecontrol
    #            name: dsh-wei-sitecontrol

    # 3) register the skill (optional but recommended, so agents find it)
    #    copy skill/SKILL.md to %USERPROFILE%\.dsh\skills\dsh-wei-sitecontrol\SKILL.md

    # 4) restart dsh web

Option B - from the source folder (developers)

    cd <plugin dir>
    npm install
    # let the profile resolve the bare package name
    # (Windows: a junction, the equivalent of ln -s on Linux)
    cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-wei-sitecontrol" "<abs plugin dir>"
    # then steps 2-4 above

Option C - once published to npm

    dsh plugin --profile web add dsh-wei-sitecontrol

5. Quick start
--------------------------------------------------------------------------------
  1) Start DSH Web (dsh web) and open it in a browser.
  2) Look at the bottom of the sidebar: "> Site Control" - open the panel.
  3) Register a site: name, workspace (absolute path), start command, port and
     health path.
  4) Press Start; the status lamp turns green. Use Logs for output, Health for
     an HTTP probe, Git to commit/push, and Deploy to preview and publish.

6. Data location and security
--------------------------------------------------------------------------------
  * Registry, keys, deploy scripts and logs live in:
    $DSH_HOME/storages/dsh-wei-sitecontrol/
      registry.json      sites and deploy targets (never key material)
      keys/<name>.pem    private keys, POSIX 600 / Windows ACL current user only
      scripts/<name>.sh  remote deploy scripts (run via bash -s from stdin, so
                         nothing is left behind on the server)
      logs/              per-site on-disk logs
  * Keys are validated on import: non-PEM is rejected, unparsable is rejected,
    path traversal in a key name is rejected, re-import needs an explicit
    overwrite flag. Responses carry only bytes / uploadedAt / keyType /
    encrypted / fingerprint (SHA256:...) / warning.
  * Note: ssh2 does not support PKCS#8 ("BEGIN PRIVATE KEY"). Such keys are
    accepted but flagged with a warning - convert them first:
    ssh-keygen -p -m PEM -f key.pem
  * Uninstalling: remove the plugin row from the profile patch, remove the
    node_modules link, and optionally delete the data directory. On unload the
    plugin stops every site it started and releases its routes and timers.

7. SSH deploys
--------------------------------------------------------------------------------
  * Description-driven setup (recommended): hand the plugin one block of text,
    for example
      "ip:203.0.113.10 / ssh port:TCP:22 / desc: company site, tomcat service,
       tomcat home /opt/tomcat9, publish dir /srv/www"
    It parses host, port, service kind, app home and publish dir, stores them
    immediately (a later SSH failure loses nothing), then connects and reads the
    server's own configuration (<Context docBase>, nginx root, DocumentRoot),
    lets the server's truth override the guesses, and stores a timestamped
    verified snapshot.
  * Release mode (recommended, rollback-able):
      collect -> connect -> detect -> mkdir <releasesDir>/<YYYYMMDD-HHMMSS>
      -> upload into the new directory -> read config and rewrite docBase
      -> back up the config as .bak-<timestamp>
      -> write the new config to a temp file and mv it atomically
      -> restart -> curl verify -> prune old releases (keep N)
    Old release directories stay on disk until pruned, so rollback is always
    possible. If no matching Context is found the plugin refuses to rewrite and
    aborts - it never guesses and never blind-edits.
  * Rollback: from the release history in the panel, or via site_rollback.
  * Scheduled publishing: schedules are stored in the registry and re-armed
    after a DSH restart. A scheduled publish runs exactly the same code path as
    a manual one, and the per-step report (including a failed step) is recorded.

8. Known limitations
--------------------------------------------------------------------------------
  * The built-in git supports HTTP(S) remotes only; SSH remotes such as
    git@host:path cannot be pushed (isomorphic-git has no SSH transport).
    Local status/commit are unaffected.
  * The git HTTP transport is implemented by this plugin (lib/githttp.js)
    because isomorphic-git's own Node client has two sharp edges:
    (1) it delegates to simple-get, and Node 19+ defaults its global agent to
    keepAlive + timeout:5000, so a server that stays quiet for five seconds -
    which GitHub's receive-pack does while it processes an uploaded packfile -
    fails with a "Request timed out" that names nothing real; (2) Node's
    http(s).request ignores the Windows system proxy, so on a machine that
    reaches GitHub only through a local proxy you get connect ETIMEDOUT.
    Current behaviour: own connections and idle timeout; on a direct-connect
    failure it retries through HTTPS_PROXY / HTTP_PROXY / ALL_PROXY, or a
    discovered local proxy (127.0.0.1:7890 and friends) via an HTTP CONNECT
    tunnel - while 127.*, 192.168.*, 10.*, 172.16-31.* and anything matched by
    NO_PROXY always go direct, so a LAN git server is never routed the long way.
  * Sites are child processes of the DSH process and are reclaimed when DSH
    exits. For long-term supervision use systemd / pm2 and register the service
    here for deploys.
  * On Windows a site is stopped with taskkill /T /F; on POSIX the process group
    gets SIGTERM, then SIGKILL.
  * Without a configured health path, Health can only tell whether the process
    is alive.

9. Credits and license
--------------------------------------------------------------------------------
  * License: MIT - see LICENSE.
  * MIT-licensed projects consulted during development: see
    THIRD_PARTY_NOTICES.md (dsh-farm, dsh-remote, dsh-ssh-remote).
  * Runs on DeepSeek Harness (@deepseek-ai/dsh, MIT) but is not affiliated with
    that project's official distribution; please report plugin issues in this
    plugin's repository.

================================================================================
 (c) 2026 mrwei - MIT
================================================================================
