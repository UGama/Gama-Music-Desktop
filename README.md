# Gama Music

Gama Music 是一个 iPhone 优先的个人音乐播放器。它可以在 Mac 上运行一个本地服务，用 Chrome 已登录的 Bilibili 账号 Cookie 调用 `yt-dlp` 下载视频音频，并转换成 MP3；iPhone 用 Safari 打开这个服务，就能播放、改名、建播放列表和切换播放模式。

## 功能

- iPhone Safari 适配，可添加到主屏幕，应用名为 `Gama Music`。
- 输入 Bilibili 视频 URL，先检查标题和是否重复，再下载 MP3。
- 下载使用 Mac 上 Chrome 已登录账号的 Cookie：`yt-dlp --cookies-from-browser chrome`。
- 基于 BV/AV ID、规范化 Bilibili URL 和去追踪参数后的 URL 做重复检查。
- 默认歌曲名使用视频标题，下载前可改，下载后也可改。
- 支持创建、改名、删除播放列表，给播放列表添加或移除歌曲。
- 支持单曲循环、列表循环、随机播放。
- 本地保存歌曲元数据和播放列表，MP3 文件保存在项目的 `media/` 文件夹。
- 可把指定 MP3 通过 Wi-Fi 保存到 iPhone 的 PWA 本地存储，之后优先播放 iPhone 副本。
- 离线保留歌曲清单，显示已保存数量和大致存储占用，并可删除 iPhone 本地副本。
- iPhone 使用精简播放器布局，不显示 Bilibili 下载表单；下载功能仅在电脑网页端显示。

## Mac 启动

要求：

- macOS
- Node.js 18 或更新版本
- `yt-dlp`
- `ffmpeg`
- Chrome 已登录 Bilibili

如果还没有 `yt-dlp` 和 `ffmpeg`，可先运行：

```bash
cd /path/to/Gama-Music
./scripts/install-mac-tools.sh
```

启动服务：

```bash
cd /path/to/Gama-Music
./scripts/start-mac-server.sh
```

启动后终端会显示几个地址，例如：

```text
http://localhost:7330
http://192.168.1.10:7330
```

iPhone 和 Mac 连同一个 Wi-Fi 后，在 iPhone Safari 打开 `http://你的Mac局域网IP:7330`。

如果 macOS 弹出网络访问或钥匙串权限提示，请允许。`yt-dlp` 读取 Chrome Cookie 时可能需要钥匙串权限。

## iPhone 使用

1. 在 Mac 上保持 Gama Music 服务运行。
2. iPhone 和 Mac 连同一个 Wi-Fi。
3. iPhone Safari 打开 Mac 的局域网地址，例如 `http://192.168.1.10:7330`。
4. 点 Safari 分享按钮，选择“添加到主屏幕”。
5. 打开主屏幕上的 `Gama Music`。

注意：如果只用 `http://` 局域网地址，iPhone 可以保存歌曲，但完整 PWA 的离线启动需要 HTTPS。想在关闭 Mac 后重新打开 Gama Music，前端应通过 GitHub Pages 或受信任的 HTTPS 地址打开；Mac 媒体服务也需要 HTTPS，才能让 HTTPS 页面在同一 Wi-Fi 下读取歌曲。

## 保存到 iPhone 并离线播放

1. 让 iPhone 和 Mac 连接同一个 Wi-Fi，并确认页面顶部显示“Mac 服务已连接”。
2. 在 iPhone 的歌曲操作区点向下箭头按钮。这个按钮只在手机界面显示；在 Mac 上点击网页存储只能保存到 Mac 浏览器，不能传到 iPhone。
3. 等待提示“已保存到 iPhone”，歌曲名旁会出现 `iPhone` 标识。
4. 保存完成后，播放器会优先读取 iPhone 本地副本，不再从 Mac 串流。
5. 蓝色对勾表示已经保存在 iPhone；点对勾可删除手机副本，Mac 上的 MP3 会保留。

Mac、iPhone 和不同浏览器的本地存储彼此独立。Mac 删除音乐库里的 MP3 不会远程删除已经保存到 iPhone 的副本；iPhone 下次连接后，这首歌会标记为“仅存 iPhone”，仍可播放。要删除它，需要在 iPhone 上点已保存按钮并确认。

“iPhone 本地”一栏会显示已保存歌曲数量和大致占用空间。音频存放在该 PWA 的 IndexedDB 中，不会出现在“文件”App。删除主屏幕上的 PWA、清除 Safari 网站数据，或系统在存储空间紧张时清理网站数据，都可能删除这些离线歌曲。

首次离线使用前，应在歌曲保存完成后打开一次 Gama Music，然后关闭 Mac 服务并测试播放。只有标有 `iPhone` 的歌曲可以脱离 Mac 播放。

## 下载歌曲

1. 复制 Bilibili 视频 URL。
2. 粘贴到 Gama Music 的 URL 输入框。
3. 点“检查”，系统会读取视频标题并判断是否已经下载过。
4. 如果不重复，可以修改歌曲名，然后点“下载 MP3”。
5. 下载完成后，歌曲会出现在音乐库。

重复检查会优先识别 `BV...` 和 `av...`，也会保存规范化 URL。不同分享链接、带追踪参数的链接会尽量归并到同一个视频。

## 数据保存位置

- 歌曲和播放列表资料：`data/library.json`
- MP3 文件：`media/*.mp3`

这两个位置默认不建议提交到 GitHub，`.gitignore` 已经排除了它们。

## GitHub Pages 说明

纯 GitHub Pages 只能托管静态前端，不能运行 `yt-dlp`、不能调用 `ffmpeg`、也不能在服务器端保存 MP3。

这个项目采用现实架构：

- 前端 PWA：可以放在 GitHub Pages。
- 下载和媒体服务：必须由 Mac 本地服务或一个你自己部署的后端提供。

如果你把前端放到 GitHub Pages，有两种方式：

1. 最省事：继续直接用 Mac 服务地址打开，也就是 `http://Mac-IP:7330`，不要走 GitHub Pages。
2. 如果一定要用 GitHub Pages：打开页面右上角设置，把“Mac 服务地址”填成你的后端地址。

重要限制：

- GitHub Pages 是 HTTPS 页面。
- HTTPS 页面通常不能直接请求 `http://192.168.x.x:7330` 这种 HTTP 局域网地址，Safari 可能会拦截。
- 要让 GitHub Pages 前端稳定连接后端，后端也应是 HTTPS。可以用本地证书、Cloudflare Tunnel、Tailscale Funnel、ngrok，或部署一个有 HTTPS 的后端。
- 不要把带 Chrome Cookie 下载能力的服务直接裸露到公网。

本项目附带一个 GitHub Pages 工作流示例，可把 `web/` 静态前端发布到 Pages。进入 GitHub 仓库的 Settings -> Pages，把 Source 设为 GitHub Actions。

## 本地 HTTPS 可选方案

如果你已经准备好了本地 HTTPS 证书和私钥，可以这样启动：

```bash
GAMA_MUSIC_HTTPS_CERT=/path/to/cert.pem \
GAMA_MUSIC_HTTPS_KEY=/path/to/key.pem \
./scripts/start-mac-server.sh
```

iPhone 必须信任这个证书，否则 Safari 会拦截。真实使用时，Cloudflare Tunnel 或 Tailscale 这类带 HTTPS 的隧道通常更省心。

## 常用环境变量

- `PORT=7330`：修改服务端口。
- `HOST=0.0.0.0`：让局域网设备能访问，默认就是这个值。
- `GAMA_MUSIC_COOKIE_BROWSER=chrome`：指定 `yt-dlp` 读取哪个浏览器的 Cookie。默认 Chrome。可设为 `none` 关闭浏览器 Cookie。
- `GAMA_MUSIC_YTDLP=/path/to/yt-dlp`：指定 `yt-dlp` 路径。
- `GAMA_MUSIC_HTTPS_CERT=/path/to/cert.pem`：HTTPS 证书。
- `GAMA_MUSIC_HTTPS_KEY=/path/to/key.pem`：HTTPS 私钥。

## GitHub Pages 工作流

仓库里包含 `.github/workflows/pages.yml`。提交到 `main` 分支后，GitHub Actions 会把 `web/` 文件夹作为静态站点发布。

如果你只想手动上传，也可以只上传 `web/` 里的文件到一个 GitHub Pages 仓库根目录。但下载功能仍然需要连接 Mac 本地服务或 HTTPS 后端。

## 安全提醒

这个服务适合在自己的 Mac 和局域网里使用。它能调用你 Mac 上的 Chrome Cookie 下载内容，不建议直接暴露到公网。如果需要远程访问，请使用带登录保护的隧道或网关。
