# Coolify on WSL2 部署说明

> 相关文档：[Coolify 部署 GitHub 项目 · 保姆级指南](<E:\pc\桌面\wsl2\Coolify-GitHub项目一键部署指南.md>)

部署完成时间：2026-10-19  
环境：Windows 11 Build 26200 / WSL 3.0.3 / Ubuntu 24.04 LTS

## 1. 访问信息

- 面板地址：<http://localhost:8000>
- 管理员邮箱：`admin@gmail.com`
- 管理员密码：`Coolify@2026!Local`

> 该邮箱只用于通过 Coolify 的 `email:rfc,dns` 校验，不会真的收信。  
> 首次登录后建议在 Profile 中修改邮箱和密码。不要把 8000 端口直接暴露到公网。

## 2. 当前组件版本

| 组件 | 版本 |
|---|---|
| Ubuntu | 24.04 LTS (noble) |
| Docker Engine | 29.9.1 |
| Docker Compose | v5.6.0 |
| Coolify | v4.5.1（镜像 latest） |
| 容器 | `coolify`、`coolify-db`、`coolify-redis` |

## 3. 关键路径

- Coolify 数据目录：`/data/coolify`
- Compose 与环境文件：`/data/coolify/source/`
  - `docker-compose.yml`
  - `docker-compose.prod.yml`
  - `.env`（含数据库密码、APP_KEY、管理员初始账号）
- Coolify 容器内应用目录：`/var/www/html`
- 安装日志：`/data/coolify/source/installation-*.log`
- 升级/拉镜像日志：`/data/coolify/source/upgrade-*.log`

`.env` 里有数据库密码和 APP_KEY，备份时请当作敏感文件处理。

## 4. 常用命令（Windows PowerShell）

进入 Ubuntu：

```powershell
wsl -d Ubuntu-24.04
```

查看容器：

```powershell
wsl -d Ubuntu-24.04 -u root -- docker ps -a
```

查看 Coolify 日志：

```powershell
wsl -d Ubuntu-24.04 -u root -- docker logs --tail 100 coolify
```

重启 Coolify：

```powershell
wsl -d Ubuntu-24.04 -u root -- docker restart coolify
```

停止 / 启动整套：

```powershell
wsl -d Ubuntu-24.04 -u root -- bash -lc "cd /data/coolify/source && docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml down"
wsl -d Ubuntu-24.04 -u root -- bash -lc "cd /data/coolify/source && REGISTRY_URL=docker.1ms.run LATEST_IMAGE=latest docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml up -d"
```

如果 WSL 整个卡死：

```powershell
wsl --shutdown
Start-Sleep -Seconds 10
wsl -d Ubuntu-24.04 -u root -- true
```

Docker 和三个容器都是 `restart: always`，WSL 重新启动后会自动拉起，等 1~2 分钟再访问面板。

WSL 在没有前台会话时可能自动停止，所以已经配置了常驻保活：

- 登录自启：`C:\Users\pc\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Coolify-WSL-Autostart.vbs`
- 手动恢复：双击 `E:\pc\桌面\wsl2\启动Coolify.cmd`

保活脚本会在 WSL 内启动 `sleep infinity`，让发行版持续运行。如果手动执行过 `wsl --shutdown`，双击一次 `启动Coolify.cmd` 即可恢复。

另外还有一个每分钟运行的计划任务 `Coolify WSL Watchdog`，发现 `wsl.exe` 不存在时会自动启动保活。`C:\Users\pc\.wslconfig` 也已设置 `vmIdleTimeout=-1`，禁止 WSL 空闲自动关闭虚拟机。

如果 `wsl --shutdown` 卡住，可以在任务管理器结束 `wsl.exe`，或直接双击 `启动Coolify.cmd`。

## 5. 本次为绕过国内网络做的调整

官方脚本默认访问 `download.docker.com` 和 `cdn.coollabs.io`，当前网络下会被重置。实际采用了：

1. Ubuntu apt 源切换为阿里云，并强制 apt 走 IPv4。
2. Docker CE 从阿里云 Docker 镜像仓库下载 deb 包安装（用 HTTP Range 多线程分段下载绕过单连接限速）。
3. Coolify 安装脚本从 Gitee 镜像获取，compose / upgrade 资源放到 `/tmp/cdn`，脚本内 `CDN` 改为 `file:///tmp/cdn`。
4. 镜像统一走 `docker.1ms.run`：
   - `docker.1ms.run/coollabsio/coolify:latest`
   - `docker.1ms.run/coollabsio/coolify-helper:latest`
   - `postgres:15-alpine`、`redis:7-alpine`
5. Docker daemon 配置了 `registry-mirrors: https://docker.1ms.run`。
6. 管理员通过 `RootUserSeeder` 创建；因 Coolify 使用 `email:rfc,dns`（要求域名有 MX 记录），最终使用 `admin@gmail.com`。

## 6. 端口访问说明

当前 Windows 的 WSL localhost 转发正常，直接访问：

```text
http://localhost:8000
```

即可，不需要 `.wslconfig` 的 mirrored 模式，也不需要 `netsh portproxy`。

如果以后 localhost 访问不了，先查 WSL 当前 IP：

```powershell
wsl -d Ubuntu-24.04 -u root -- hostname -I
```

然后用 `http://<WSL_IP>:8000` 测试。WSL IP 每次重启可能变化。  
若要让局域网其他设备访问，需要额外做端口转发和 Windows 防火墙入站规则，不建议在测试环境长期开启。

## 7. 已完成的验证

- `http://localhost:8000/login` 返回 HTTP 200。
- 管理员账号登录成功，进入 `Dashboard | Coolify`。
- Dashboard 的 Servers 列表中已有 `localhost`，提示为 “This is the server where Coolify is running on.”
- `coolify`、`coolify-db`、`coolify-redis` 均为 healthy。
- Docker 已 `systemctl enable`，`pc` 用户已加入 `docker` 组。
- 容器重启策略为 `always`，WSL 重启后可自动恢复。

## 8. 注意事项

- 这是 WSL2 本地测试环境，不建议作为生产环境。
- 不要删除 `localhost` 服务器，否则 Coolify 无法管理本机。
- 不要执行 `docker system prune -a`，会删掉 Coolify 正在使用的镜像。
- 升级 Coolify 前先备份 `/data/coolify/source/.env` 和数据库卷。
- 如需重置管理员密码，可在容器内用 `php artisan tinker` 修改 `users` 表中 id=0 的记录。
