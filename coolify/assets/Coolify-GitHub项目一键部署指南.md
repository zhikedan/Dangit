# Coolify 部署 GitHub 项目 · 保姆级指南

> 适用环境：Windows 11 + WSL2 Ubuntu 24.04 + 本机 Coolify v4.5.x  
> Coolify 面板：<http://localhost:8000>  
> 本文目标：把 GitHub 上的项目（公开/私有、Node/Python/PHP/Java/Go、Dockerfile/Compose）部署到本机 Coolify，并处理常见报错。

---

## 目录

1. [先理解 Coolify 是怎么部署的](#1-先理解-coolify-是怎么部署的)
2. [部署前准备](#2-部署前准备)
3. [连接 GitHub（公开仓库 / 私有仓库）](#3-连接-github公开仓库--私有仓库)
4. [方式一：公开仓库一键部署](#4-方式一公开仓库一键部署)
5. [方式二：私有仓库一键部署（GitHub App）](#5-方式二私有仓库一键部署github-app)
6. [构建方式怎么选：Nixpacks / Dockerfile / Compose / Static](#6-构建方式怎么选)
7. [应用配置：端口、域名、环境变量、存储](#7-应用配置端口域名环境变量存储)
8. [数据库和 Redis 怎么接](#8-数据库和-redis-怎么接)
9. [自动部署 / Webhook（本机 WSL 的重点）](#9-自动部署--webhook本机-wsl-的重点)
10. [部署后验证](#10-部署后验证)
11. [常见报错与解决方案](#11-常见报错与解决方案)
12. [WSL2 特有问题](#12-wsl2-特有问题)
13. [回滚、日志、终端、备份](#13-回滚日志终端备份)
14. [最小示例：Node.js + PostgreSQL](#14-最小示例nodejs--postgresql)
15. [安全建议](#15-安全建议)
16. [速查清单](#16-速查清单)

---

## 1. 先理解 Coolify 是怎么部署的

Coolify 不是“把代码复制到某个目录再运行”，它的流程是：

```text
GitHub 仓库
   │  git clone / GitHub App
   ▼
Coolify 创建一次 Deployment
   │  选择 Build Pack
   ├─ Nixpacks：自动识别语言并生成镜像
   ├─ Dockerfile：用你的 Dockerfile 构建
   ├─ Docker Compose：用你的 compose 文件起多个容器
   └─ Static：只构建静态文件，交给 Nginx
   ▼
Docker 镜像
   ▼
容器（应用）
   ▼
Coolify Proxy（Traefik）监听 80/443
   ▼
域名 / localhost 访问
```

几个关键概念：

| 概念 | 含义 |
|---|---|
| Project | 项目，里面可以放多个应用、数据库 |
| Environment | 环境，默认 `production`，也可以建 `staging` |
| Resource | 一个具体资源：应用、数据库、服务 |
| Build Pack | 构建方式：Nixpacks、Dockerfile、Compose、Static |
| Ports Exposes | **容器内部**监听的端口，不是 Windows 端口 |
| Domains | 浏览器访问用的域名，由 Traefik 转发到容器端口 |
| Persistent Storage | 持久化目录，容器重建后数据还在 |
| Deployment | 一次部署记录，可看日志、回滚 |

> 最容易搞错的一点：  
> **Ports Exposes 填 3000，不代表浏览器访问 3000。**  
> 浏览器访问的是 Domains 里的域名（默认 80 端口），Traefik 再转到容器的 3000。

---

## 2. 部署前准备

### 2.1 确认 Coolify 正在运行

Windows 浏览器打开：

```text
http://localhost:8000
```

如果出现 `ERR_CONNECTION_REFUSED`：

1. 双击 `E:\pc\桌面\wsl2\启动Coolify.cmd`；
2. 等 30 秒；
3. 再刷新浏览器。

仍然不行，见 [第 12 节 WSL2 特有问题](#12-wsl2-特有问题)。

### 2.2 确认 GitHub 仓库里有可部署的东西

Coolify 支持这些项目：

| 项目类型 | 需要什么 |
|---|---|
| Node.js | `package.json`，有 `start` 或 `build` 脚本 |
| Python | `requirements.txt` / `pyproject.toml`，有启动命令 |
| PHP | `composer.json`，Web 根目录通常是 `public` |
| Java | `pom.xml` / `gradle.build`，构建出 jar |
| Go | `go.mod`，能 `go build` |
| 任意语言 | 仓库里有 `Dockerfile` |
| 多服务 | 仓库里有 `docker-compose.yml` |
| 纯前端 | `npm run build` 生成 `dist` / `build` 目录 |

### 2.3 应用必须监听 `0.0.0.0`

这是新手最常见的 502 原因。

错误写法：

```js
app.listen(3000, '127.0.0.1');
```

正确写法：

```js
app.listen(process.env.PORT || 3000, '0.0.0.0');
```

Python：

```python
uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
```

PHP-FPM / Nginx 镜像通常已经监听 `0.0.0.0`，不用改。

### 2.4 确认端口不冲突

Coolify 的 Traefik 会占用 80/443。Windows 上如果 IIS、Apache、nginx 或别的 Docker 容器占了 80，代理会起不来。

在 PowerShell 检查：

```powershell
netstat -ano | findstr ":80 "
netstat -ano | findstr ":443 "
```

如果被占用，先停止对应服务，或在 Coolify 的 `Servers -> localhost -> Proxy` 里改 Traefik 的监听端口。

### 2.5 确认 WSL 和 Docker 正常

```powershell
wsl -d Ubuntu-24.04 -u root -- docker ps
```

应该能看到 `coolify`、`coolify-db`、`coolify-redis`、`coolify-proxy`。

如果 Docker 没启动：

```powershell
wsl -d Ubuntu-24.04 -u root -- systemctl start docker
```

---

## 3. 连接 GitHub（公开仓库 / 私有仓库）

Coolify 的 `Sources` 支持两种 GitHub 接入方式：

| 方式 | 适用 | 能否自动部署 |
|---|---|---|
| Public Repository | 公开仓库 | 需要手动加 Webhook（本机 WSL 通常不可达） |
| GitHub App | 公开/私有仓库 | GitHub App 自动带 Webhook，但本机 WSL 仍需要公网入口 |

### 3.1 公开仓库：不需要连接 GitHub

如果仓库是公开的，直接：

```text
Projects -> 选择项目 -> Add Resource -> Public Repository
```

粘贴：

```text
https://github.com/用户名/仓库名
```

选择分支即可。Coolify 会通过 HTTPS clone，不需要 GitHub 账号。

### 3.2 私有仓库：创建 GitHub App

进入：

```text
左侧 Sources -> Add -> GitHub App
```

Coolify 会给你两种方式：

1. **Register a GitHub App（推荐）**：点按钮，跳转 GitHub，按提示创建 App 并安装到你的账号/组织；
2. **Manual**：手动填 App ID、Client ID、Client Secret、Webhook Secret、Private Key。

推荐用第 1 种。创建时注意：

- 选择你的 GitHub 账号或组织；
- 只授权需要部署的仓库（Repository access 选 `Only select repositories`）；
- 权限至少需要：
  - Contents: Read
  - Metadata: Read
  - Pull requests: Read（可选）
  - Webhooks: Read & write（如果要自动部署）
- 安装完成后，Coolify 的 Sources 里会显示这个 GitHub App。

#### 私有仓库拉取失败：Repository not found

99% 是 GitHub App 没有安装到该仓库。

解决：

```text
GitHub -> Settings -> Applications -> 你的 Coolify App -> Configure
-> Repository access -> 勾选目标仓库 -> Save
```

然后回 Coolify 重新选择仓库。

#### 私有仓库拉取失败：Permission denied (publickey)

说明 Coolify 用的是 SSH deploy key，不是 GitHub App：

- 检查仓库 `Settings -> Deploy keys` 是否添加了 Coolify 生成的公钥；
- 或者改用 GitHub App 方式重新添加资源。

---

## 4. 方式一：公开仓库一键部署

这是最快的方式，适合开源项目、Demo、个人项目。

### 第 1 步：创建项目

```text
左侧 Projects -> + Add
```

填写：

- Name：`my-app`
- Description：随便写

创建后会进入项目页面。

### 第 2 步：添加资源

点击：

```text
+ Add Resource -> Public Repository
```

填写：

| 字段 | 示例 | 说明 |
|---|---|---|
| Repository URL | `https://github.com/vercel/next-learn` | 公开仓库地址 |
| Branch | `main` | 要部署的分支 |
| Build Pack | `Nixpacks` | 先自动识别 |
| Ports Exposes | `3000` | 容器内部端口 |
| Base Directory | `/` | 仓库根目录；monorepo 才改 |

点 `Continue` / `Create`。

### 第 3 步：配置域名

在应用的 `General` 或 `Domains` 里填：

```text
http://my-app.localhost
```

或者：

```text
http://my-app.127.0.0.1.nip.io
```

保存。

> `*.localhost` 在现代 Chrome/Edge 会自动解析到 127.0.0.1。  
> 如果浏览器不认，用管理员权限编辑：
> `C:\Windows\System32\drivers\etc\hosts`
> 加一行：
> `127.0.0.1 my-app.localhost`

### 第 4 步：点 Deploy

点击右上角 `Deploy`。然后在 `Deployments` / `Logs` 看构建日志。

首次部署一般 1~5 分钟。看到：

```text
Deployment finished
```

并且容器状态是 `Running` / `Healthy`，就成功了。

### 第 5 步：访问

```text
http://my-app.localhost
```

如果 502，跳到 [第 11 节](#11-常见报错与解决方案)。

---

## 5. 方式二：私有仓库一键部署（GitHub App）

### 第 1 步：确认 GitHub App 已安装

```text
Sources -> GitHub App -> 你的 App -> Configure
```

确保目标仓库在授权列表里。

### 第 2 步：添加资源

```text
项目 -> + Add Resource -> Private Repository (with GitHub App)
```

选择：

- GitHub App
- Repository
- Branch
- Build Pack
- Ports Exposes

### 第 3 步：后续配置

和公开仓库一样：域名、环境变量、存储、Deploy。

### 第 4 步：代码更新后怎么部署

有两种方式：

1. **手动**：改完代码 push 后，在 Coolify 点 `Deploy`；
2. **自动**：配置 Webhook（见第 9 节）。  
   但本机 WSL 没有公网地址，GitHub 无法回调 `localhost`，所以自动部署通常需要内网穿透。

---

## 6. 构建方式怎么选

### 6.1 Nixpacks（推荐先试）

适合：

- Node.js / Python / PHP / Go / Java / Ruby
- 项目结构标准
- 不想写 Dockerfile

Coolify 会自动检测语言并生成构建步骤。

常见需要手动指定的变量：

| 变量 | 用途 |
|---|---|
| `NIXPACKS_NODE_VERSION` | 指定 Node 版本，如 `20` |
| `NIXPACKS_PHP_VERSION` | 指定 PHP 版本，如 `8.3` |
| `NIXPACKS_PYTHON_VERSION` | 指定 Python 版本 |
| `NIXPACKS_BUILD_CMD` | 自定义构建命令 |
| `NIXPACKS_START_CMD` | 自定义启动命令 |

Node 项目的最小要求：

```json
{
  "scripts": {
    "build": "next build",
    "start": "next start -p ${PORT:-3000}"
  }
}
```

如果 `package.json` 没有 `start`，Nixpacks 可能不知道如何启动，日志会报：

```text
No start command detected
```

解决：加 `start` 脚本，或在 Coolify 的 `Start Command` 里显式填写。

### 6.2 Dockerfile

适合：

- 仓库里已经有 Dockerfile
- 需要精确控制运行环境
- Nixpacks 构建失败

填写：

| 字段 | 说明 |
|---|---|
| Dockerfile Location | 默认 `/Dockerfile` |
| Build Context | 默认 `/` |
| Ports Exposes | Dockerfile 里 `EXPOSE` 的端口 |
| Build Args | 构建参数 |

一个最小 Node Dockerfile：

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

注意：

- `EXPOSE` 只是声明，真正监听要代码里 `0.0.0.0`；
- 多阶段构建更小；
- 不要用 `FROM --platform=...` 除非你明确知道架构；WSL 是 `amd64`。

### 6.3 Docker Compose

适合：

- 仓库里有 `docker-compose.yml`
- 一次要起多个服务（web + worker + db）

在 Coolify 里选 `Docker Compose`，填：

- Compose File Location：`/docker-compose.yml`
- 如果 compose 里用了 `.env`，在 Coolify 的 Environment Variables 里补齐

Coolify 会：

- 注入环境变量；
- 给 compose 项目加网络；
- 通过 `SERVICE_FQDN_<服务名>` 生成域名；
- 用 `SERVICE_URL_<服务名>` 给其他服务引用。

示例：

```yaml
services:
  web:
    build: .
    ports:
      - "3000"
    environment:
      DATABASE_URL: postgres://postgres:${DB_PASSWORD}@db:5432/app
    depends_on:
      - db
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

Coolify 里设置：

```text
SERVICE_FQDN_WEB=web.localhost
DB_PASSWORD=换成强密码
```

> Compose 模式最容易出的问题是“端口/域名对不上”。  
> 记住：Coolify 的域名是绑到**某个 service** 的，不是整个 compose 文件。

### 6.4 Static

适合：

- Vue / React / Vite / Astro / Hugo 等纯静态站点
- 构建产物是 `dist` / `build` / `out`

填写：

- Build Command：`npm run build`
- Publish Directory：`dist`（Vite）或 `build`（CRA）或 `out`（Next static export）

不需要 `Ports Exposes`，Coolify 会用 Nginx 直接托管。

---

## 7. 应用配置：端口、域名、环境变量、存储

### 7.1 端口

`Ports Exposes` 填**容器内部端口**：

| 框架 | 常见端口 |
|---|---|
| Node/Express | 3000 |
| Next.js | 3000 |
| NestJS | 3000 |
| Django | 8000 |
| FastAPI | 8000 |
| Flask | 5000 |
| Spring Boot | 8080 |
| Go | 8080 |
| PHP-FPM + Nginx | 80 |

如果应用读 `PORT` 环境变量，在 Coolify 里加：

```text
PORT=3000
```

### 7.2 域名

本地测试推荐：

```text
http://项目名.localhost
```

或：

```text
http://项目名.127.0.0.1.nip.io
```

不要填：

```text
http://localhost:3000
```

因为 3000 不是 Traefik 的入口，Coolify 也不会自动把 3000 暴露到 Windows。

如果要让局域网访问，需要：

1. 在 Coolify 里给应用绑定域名；
2. Windows 做端口转发/防火墙；
3. 或者用 Cloudflare Tunnel。

### 7.3 环境变量

在应用的 `Environment Variables` 里添加。

注意：

- 前端变量（如 `NEXT_PUBLIC_API_URL`、`VITE_API_URL`）是**构建时**注入的，改完要重新 Deploy；
- 后端变量是运行时注入，改完重启容器即可；
- 密码、Token 用 `Lock` 锁定，避免误改；
- 不要把 `.env` 提交到 Git。

### 7.4 持久化存储

如果应用要保存上传文件、SQLite、缓存：

```text
Persistent Storage -> Add
```

填写：

- Name：`uploads`
- Mount Path：容器内路径，如 `/app/uploads`
- Volume Name：自动生成

数据库不要用这种方式，直接用 Coolify 的 Database 资源。

### 7.5 健康检查

Coolify 默认用容器状态判断。建议加 HTTP 健康检查：

```text
Health Check Path: /health
Health Check Port: 3000
```

应用里提供：

```js
app.get('/health', (req, res) => res.json({ok: true}));
```

没有健康检查也能跑，但出问题时 Coolify 不容易判断“容器起来了但应用没起来”。

---

## 8. 数据库和 Redis 怎么接

### 8.1 在 Coolify 里创建数据库

```text
项目 -> + Add Resource -> Database -> PostgreSQL / MySQL / MariaDB / Redis / MongoDB
```

创建后，Coolify 会显示：

- Internal URL（容器内网地址）
- Public URL（如果你开了公网端口）
- Username / Password / Database

### 8.2 应用怎么连

**同一个 Coolify 项目 / 同一个 Docker 网络里**，用 Internal URL，不要用 `localhost`。

错误：

```text
postgres://user:pass@localhost:5432/app
```

正确：

```text
postgres://user:pass@<数据库服务名>:5432/app
```

Coolify 的 Internal URL 会直接给你完整字符串，复制即可。

### 8.3 数据库迁移

部署时执行迁移，常见做法：

- 在 `Start Command` 前加：

```bash
npx prisma migrate deploy && npm start
```

- 或者用 Coolify 的 `Pre-deployment Command`（如果有）；
- 或者在应用启动脚本里判断并执行。

注意：多副本时不要每个副本都跑迁移；本地单副本没问题。

### 8.4 数据持久化

Coolify 创建的数据库默认带 volume，删除资源时要确认是否保留 volume。

备份：

```powershell
wsl -d Ubuntu-24.04 -u root -- docker exec coolify-db pg_dump -U coolify coolify > backup.sql
```

（数据库容器名以实际为准。）

---

## 9. 自动部署 / Webhook（本机 WSL 的重点）

### 9.1 先理解：本机 WSL 没有公网地址

GitHub 的 Webhook 是 **GitHub 服务器主动请求你的 Coolify**。

你的 Coolify 地址是：

```text
http://localhost:8000
```

这个地址只在你的电脑上有效，GitHub 无法访问。  
所以：

- **公开仓库 + 手动 Deploy**：可以；
- **私有仓库 + GitHub App 拉代码**：可以（Coolify 主动出站 clone）；
- **push 后自动部署**：默认不行，需要内网穿透。

### 9.2 方案 A：手动部署（最简单）

改完代码：

```bash
git add .
git commit -m "update"
git push
```

然后到 Coolify 点 `Deploy`。

适合本地开发、学习、低频部署。

### 9.3 方案 B：Cloudflare Tunnel / ngrok（推荐要自动部署时）

以 Cloudflare Tunnel 为例：

1. 安装 `cloudflared`；
2. 建隧道：

```powershell
cloudflared tunnel --url http://localhost:8000
```

3. 会得到一个公网地址，例如：

```text
https://coolify-demo.trycloudflare.com
```

4. 把这个地址填到 Coolify 的 `APP_URL` / `WEBHOOK_URL`（如果 Coolify 设置里有）；
5. 在 GitHub App 的 Webhook URL 里填：

```text
https://coolify-demo.trycloudflare.com/webhooks/source/github/events
```

6. 在 Coolify 应用的 `Webhooks` 页面复制实际的 Webhook URL 和 Secret，不要手写。

> 临时隧道地址每次重启会变，只适合测试。  
> 长期使用建议买域名 + Cloudflare Named Tunnel。

### 9.4 方案 C：公开仓库手动加 Webhook

如果 Coolify 有公网地址：

```text
GitHub 仓库 -> Settings -> Webhooks -> Add webhook
```

- Payload URL：Coolify 应用 `Webhooks` 页面显示的公网 URL
- Content type：`application/json`
- Secret：Coolify 显示的 Secret
- Events：`Just the push event`

然后确认 Coolify 应用的 `Auto Deploy` 是开启的。

### 9.5 Webhook 常见错误

| GitHub 显示 | 原因 | 解决 |
|---|---|---|
| 404 | URL 少了 `/webhooks/...` 或应用不存在 | 从 Coolify 页面复制完整 URL |
| 401 | Secret 不一致 | 重新复制 Secret |
| 403 | 应用没开 Auto Deploy | 打开开关 |
| timeout | GitHub 访问不到 localhost | 用隧道/公网地址 |
| 200 但没部署 | 分支不匹配 | 检查 Deploy Branch / Watch Paths |

---

## 10. 部署后验证

### 10.1 看部署状态

```text
应用 -> Deployments
```

状态应该是：

```text
Finished / Success
```

### 10.2 看容器

```powershell
wsl -d Ubuntu-24.04 -u root -- docker ps
```

找到应用容器，状态是 `Up` 或 `healthy`。

### 10.3 看日志

Coolify 页面：

```text
应用 -> Logs
```

或命令行：

```powershell
wsl -d Ubuntu-24.04 -u root -- docker logs --tail 100 <容器名>
```

### 10.4 浏览器访问

```text
http://项目名.localhost
```

如果 502/504，看第 11 节。

---

## 11. 常见报错与解决方案

### 11.1 `ERR_CONNECTION_REFUSED`（localhost 拒绝连接）

原因：WSL 没启动，或 Coolify 容器没起来。

解决：

1. 双击 `E:\pc\桌面\wsl2\启动Coolify.cmd`；
2. 等 30 秒；
3. 还不行：

```powershell
wsl --shutdown
Start-Sleep -Seconds 10
wsl -d Ubuntu-24.04 -u root -- true
```

4. 再等 1~2 分钟。

### 11.2 `502 Bad Gateway`

原因：Traefik 找不到应用容器，或容器没监听正确端口。

排查：

```powershell
wsl -d Ubuntu-24.04 -u root -- docker ps
wsl -d Ubuntu-24.04 -u root -- docker logs --tail 100 <应用容器>
```

常见修复：

- `Ports Exposes` 填错：改成应用真实端口；
- 应用监听 `127.0.0.1`：改成 `0.0.0.0`；
- 应用启动崩溃：看日志里的报错；
- 健康检查路径错：改成 `/` 或 `/health`；
- 容器在重启循环：`docker ps` 会显示 `Restarting`。

### 11.3 `504 Gateway Timeout`

原因：应用启动太慢，或构建/迁移卡住。

解决：

- 看应用日志；
- 增加健康检查超时；
- 数据库没起来时，应用一直等连接；
- 大项目构建慢，等几分钟。

### 11.4 构建失败：`npm ERR!` / `pnpm ERR!`

常见原因：

1. **Node 版本不对**  
   加环境变量：

```text
NIXPACKS_NODE_VERSION=20
```

2. **lockfile 和 package.json 不一致**  
   本地执行：

```bash
rm -rf node_modules package-lock.json
npm install
git add package-lock.json
git commit -m "fix lockfile"
git push
```

3. **私有 npm 包没有 token**  
   在 Coolify 环境变量里加 `NPM_TOKEN`，并在 `.npmrc` 里引用。

4. **内存不足**  
   WSL 默认内存较小，构建大项目可能 OOM。  
   在 `C:\Users\pc\.wslconfig` 加：

```ini
[wsl2]
memory=6GB
swap=4GB
```

然后：

```powershell
wsl --shutdown
```

### 11.5 `COPY failed: file not found`

原因：`.dockerignore` 把文件排除了，或 Build Context / Dockerfile 路径不对。

解决：

- 检查 `Dockerfile Location`；
- 检查 `Build Context`；
- 看 `.dockerignore` 是否排除了 `package.json`、`dist` 等必需文件。

### 11.6 `port is already allocated`

原因：宿主机端口被占用。

解决：

- Coolify 应用不要手写 `ports: 3000:3000`，让 Traefik 转发；
- 如果必须映射端口，换一个宿主端口；
- 检查：

```powershell
netstat -ano | findstr ":3000"
```

### 11.7 数据库连接失败 `ECONNREFUSED`

原因：用了 `localhost` 而不是 Coolify 内网服务名。

解决：

- 复制 Coolify 数据库的 `Internal URL`；
- 确认应用和数据库在同一个项目/网络；
- 数据库容器是否是 `healthy`；
- 密码里如果有特殊字符，URL 要编码。

### 11.8 Prisma 迁移失败

在 Coolify 的 Start Command 里：

```bash
npx prisma migrate deploy && npm start
```

确保 `DATABASE_URL` 是内网地址。  
如果迁移需要生成 client：

```bash
npx prisma generate && npx prisma migrate deploy && npm start
```

### 11.9 Next.js 部署后 502

检查：

- `next.config.js` 是否设置了 `output: 'standalone'`；
- 启动命令是否是 `node server.js` 或 `npm start`；
- `Ports Exposes` 是否是 3000；
- 是否监听 `0.0.0.0`。

### 11.10 静态站点 404

原因：`Publish Directory` 填错。

| 框架 | 目录 |
|---|---|
| Vite | `dist` |
| Create React App | `build` |
| Next.js static export | `out` |
| Astro | `dist` |
| Vue CLI | `dist` |

### 11.11 SSL / HTTPS 失败

`localhost` 和 `*.localhost` 无法申请 Let's Encrypt 证书。

- 本地测试用 `http://`；
- 需要 HTTPS 就用真实域名 + Cloudflare Tunnel；
- 不要给 `localhost` 开 Force HTTPS。

### 11.12 GitHub 私有仓库拉取失败

- GitHub App 没安装到仓库；
- Deploy Key 没加；
- 仓库名/分支写错；
- 组织开启了 SSO，需要授权 App。

### 11.13 Docker 镜像拉取失败 / timeout

Coolify 本体镜像已经在本地，但部署新应用时可能要拉 `node`、`postgres` 等镜像。

检查 Docker 镜像加速：

```powershell
wsl -d Ubuntu-24.04 -u root -- docker info
```

应该能看到：

```text
Registry Mirrors:
 https://docker.1ms.run/
```

没有的话，编辑 `/etc/docker/daemon.json`，加：

```json
{
  "registry-mirrors": ["https://docker.1ms.run"]
}
```

然后：

```powershell
wsl -d Ubuntu-24.04 -u root -- systemctl restart docker
```

### 11.14 WSL 时间不对 / TLS 证书错误

WSL 从睡眠恢复后时间可能停在过去，导致 HTTPS 证书校验失败。

解决：

```powershell
wsl --shutdown
Start-Sleep -Seconds 10
wsl -d Ubuntu-24.04 -u root -- true
```

### 11.15 磁盘满

查看：

```powershell
wsl -d Ubuntu-24.04 -u root -- df -h /
wsl -d Ubuntu-24.04 -u root -- docker system df
```

清理（**不要**随便 `docker system prune -a`，会删掉 Coolify 镜像）：

```powershell
wsl -d Ubuntu-24.04 -u root -- docker image prune
wsl -d Ubuntu-24.04 -u root -- docker builder prune
```

---

## 12. WSL2 特有问题

### 12.1 WSL 停了，面板打不开

这是本次遇到的问题。`wsl -l -v` 显示 `Stopped`，所以 `localhost:8000` 拒绝连接。

解决：

```powershell
wsl -d Ubuntu-24.04 -u root -- true
```

或双击：

```text
E:\pc\桌面\wsl2\启动Coolify.cmd
```

已经配置了登录自启：

```text
C:\Users\pc\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Coolify-WSL-Autostart.vbs
```

这个脚本不是只跑一次 `true`，而是会在 WSL 里启动一个常驻的 `sleep infinity` 进程，防止 WSL 因为没有前台会话而自动停止。  
下次 Windows 登录会自动启动 WSL、Docker 和 Coolify 容器。

另外还创建了计划任务 `Coolify WSL Watchdog`：

- 每分钟检查一次 `wsl.exe` 进程是否存在；
- 不存在就通过 `Coolify-Watchdog.vbs` 启动 WSL 保活；
- 已在 `C:\Users\pc\.wslconfig` 里设置 `vmIdleTimeout=-1`，禁止 WSL 因空闲自动关闭虚拟机。

查看任务：

```powershell
schtasks /Query /TN "Coolify WSL Watchdog" /V /FO LIST
```

手动运行：

```powershell
schtasks /Run /TN "Coolify WSL Watchdog"
```

也可以随时双击：

```text
E:\pc\桌面\wsl2\启动Coolify.cmd
```

它会启动常驻进程，等 35 秒后自动打开浏览器。

> 如果手动执行过 `wsl --shutdown`，常驻进程会被杀掉；双击一次 `启动Coolify.cmd` 即可恢复。

### 12.2 WSL 启动后前 1 分钟 500

Coolify 比 PostgreSQL/Redis 先启动，容器 DNS 还没就绪。

等 30~60 秒，刷新即可。

### 12.3 localhost 转发失效

先查 WSL IP：

```powershell
wsl -d Ubuntu-24.04 -u root -- hostname -I
```

用 `http://<WSL_IP>:8000` 测试。

如果 WSL IP 能访问、localhost 不能，可以：

1. 重启 WSL：

```powershell
wsl --shutdown
```

2. 或者配置端口转发（管理员 PowerShell）：

```powershell
netsh interface portproxy add v4tov4 listenport=8000 listenaddress=0.0.0.0 connectport=8000 connectaddress=<WSL_IP>
```

3. 或者启用镜像网络，编辑 `C:\Users\pc\.wslconfig`：

```ini
[wsl2]
networkingMode=mirrored
```

然后：

```powershell
wsl --shutdown
```

> 镜像网络不是所有 Windows 版本都稳定；能用 localhost 就不要改。

### 12.4 WSL 内存不足

编辑 `C:\Users\pc\.wslconfig`：

```ini
[wsl2]
memory=6GB
processors=8
swap=4GB
```

然后：

```powershell
wsl --shutdown
```

### 12.5 Docker 在 WSL 重启后没起来

```powershell
wsl -d Ubuntu-24.04 -u root -- systemctl status docker
wsl -d Ubuntu-24.04 -u root -- systemctl start docker
```

Coolify 容器是 `restart: always`，Docker 起来后会自动拉起。

---

## 13. 回滚、日志、终端、备份

### 13.1 回滚

Coolify 的 `Deployments` 里可以：

- 查看历史部署；
- 重新部署某个旧 commit；
- 回滚到上一个成功版本。

最稳的回滚：

```text
应用 -> Deployments -> 找到上一个 Successful -> Redeploy
```

### 13.2 日志

- 构建日志：`Deployments -> 某次部署 -> Logs`
- 运行日志：`应用 -> Logs`
- 容器日志：

```powershell
wsl -d Ubuntu-24.04 -u root -- docker logs -f --tail 200 <容器名>
```

### 13.3 终端

Coolify 应用页面有 `Terminal`，可以直接进容器：

```bash
ls -la
env
curl localhost:3000
```

排查“容器内能不能访问自己”非常有用。

### 13.4 备份

至少备份：

1. `/data/coolify/source/.env`
2. PostgreSQL 数据卷
3. 应用持久化目录

命令：

```powershell
wsl -d Ubuntu-24.04 -u root -- tar czf /mnt/c/Users/pc/coolify-backup.tar.gz /data/coolify/source
```

数据库：

```powershell
wsl -d Ubuntu-24.04 -u root -- docker exec coolify-db pg_dump -U coolify coolify > /mnt/c/Users/pc/coolify-db.sql
```

> 备份文件里有密码和密钥，妥善保管。

---

## 14. 最小示例：Node.js + PostgreSQL

### 14.1 仓库结构

```text
my-app/
├── package.json
├── server.js
├── Dockerfile
└── .dockerignore
```

`package.json`：

```json
{
  "name": "my-app",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "pg": "^8.12.0"
  }
}
```

`server.js`：

```js
const express = require('express');
const { Pool } = require('pg');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/', async (req, res) => {
  const result = await pool.query('SELECT now()');
  res.json({ time: result.rows[0].now });
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`listening on ${port}`);
});
```

`Dockerfile`：

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

`.dockerignore`：

```text
node_modules
npm-debug.log
.git
.env
```

### 14.2 Coolify 配置

1. 创建项目 `my-app`；
2. 添加 Public Repository；
3. Build Pack：`Dockerfile`；
4. Ports Exposes：`3000`；
5. 创建 PostgreSQL 数据库；
6. 应用环境变量：

```text
DATABASE_URL=<Coolify 数据库的 Internal URL>
```

7. 域名：

```text
http://my-app.localhost
```

8. Deploy。

### 14.3 验证

```text
http://my-app.localhost/health
```

返回：

```json
{"ok":true}
```

---

## 15. 安全建议

1. 不要把这套 WSL Coolify 直接暴露到公网；
2. 管理员密码改成强密码；
3. 数据库不要开公网端口，除非必要；
4. `.env` 不要提交 Git；
5. 定期备份 `/data/coolify/source/.env` 和数据库；
6. 不要执行 `docker system prune -a`；
7. 不要删除 `localhost` 服务器；
8. 公网访问必须加 HTTPS 和访问控制。

---

## 16. 速查清单

部署一个新项目，按这个顺序：

- [ ] WSL 已启动，`http://localhost:8000` 能打开
- [ ] 仓库有 `Dockerfile` / `package.json` / `compose` / 静态产物
- [ ] 应用监听 `0.0.0.0`
- [ ] 知道容器内部端口
- [ ] Coolify 里创建项目
- [ ] 添加 Public/Private Repository
- [ ] 选对 Build Pack
- [ ] 填对 Ports Exposes
- [ ] 配好环境变量
- [ ] 需要持久化就加 Storage
- [ ] 配域名 `http://xxx.localhost`
- [ ] Deploy
- [ ] 看 Logs，确认容器 Running/Healthy
- [ ] 浏览器访问验证
- [ ] 需要自动部署就配 Webhook/隧道

---

## 17. 中文界面（本机补丁）

Coolify 自带 `lang/zh-cn.json`，但只覆盖登录页和少量提示，主界面仍然是英文硬编码，也没有语言切换入口。  
本机采用“同源翻译脚本”做界面汉化，不修改 Coolify 业务代码，也不影响部署数据。

### 17.1 当前效果

已覆盖：

- 左侧导航：仪表盘、项目、服务器、源、目标、镜像仓库、共享变量、团队、通知、密钥与令牌、标签、设置
- 仪表盘、项目页、服务器页、设置页
- 添加资源、公开/私有仓库、Dockerfile、Docker Compose、静态站点
- 部署、重新部署、日志、环境变量、持久化存储、健康检查
- 数据库、备份、连接地址
- 常见状态：运行中、已停止、健康、失败、排队中、已完成

### 17.2 相关文件

| 文件 | 作用 |
|---|---|
| `E:\pc\桌面\wsl2\coolify-zh.js` | 翻译词典和 DOM 翻译逻辑 |
| `E:\pc\桌面\wsl2\apply-coolify-zh.sh` | 把脚本复制进容器并修改布局文件 |

### 17.3 升级/重建容器后恢复汉化

Coolify 升级或 `docker compose` 重建 `coolify` 容器后，容器内的布局文件和 `public/coolify-zh.js` 会丢失。  
重新执行一次即可：

```powershell
wsl -d Ubuntu-24.04 -u root -- bash /mnt/e/pc/桌面/wsl2/apply-coolify-zh.sh
```

然后浏览器按 `Ctrl + F5` 强制刷新。

### 17.4 增加或修改翻译

1. 编辑 `E:\pc\桌面\wsl2\coolify-zh.js`；
2. 在 `const D = { ... }` 里增加英文到中文的键值对；
3. 重新执行：

```powershell
wsl -d Ubuntu-24.04 -u root -- bash /mnt/e/pc/桌面/wsl2/apply-coolify-zh.sh
```

4. 浏览器 `Ctrl + F5`。

翻译脚本只处理界面文字，会跳过 `pre`、`code`、`.font-mono`、日志和用户输入，不会改坏环境变量、命令和项目名。

---

## 附：常用命令速查

```powershell
# 启动 WSL / Coolify
wsl -d Ubuntu-24.04 -u root -- true

# 查看容器
wsl -d Ubuntu-24.04 -u root -- docker ps -a

# 查看 Coolify 日志
wsl -d Ubuntu-24.04 -u root -- docker logs --tail 100 coolify

# 重启 Coolify
wsl -d Ubuntu-24.04 -u root -- docker restart coolify

# 查看 WSL IP
wsl -d Ubuntu-24.04 -u root -- hostname -I

# 查看磁盘
wsl -d Ubuntu-24.04 -u root -- df -h /

# 查看 Docker 磁盘占用
wsl -d Ubuntu-24.04 -u root -- docker system df

# 重启 Docker
wsl -d Ubuntu-24.04 -u root -- systemctl restart docker

# 彻底重启 WSL
wsl --shutdown
```

---

**最后更新：2026-10**  
如果按本文操作仍卡住，优先看第 11、12 节；这两节覆盖了本次部署中实际遇到的连接拒绝、启动顺序、镜像拉取和 GitHub 认证问题。
