# aliceliddell.top 上线手册

> 适用现状（2026-10-27 实测）：注册商 **NameSilo**，NS 为 `ns1/ns2/ns3.dnsowl.com`，
> A 记录指向 `172.232.24.161 / 172.232.24.235 / 172.104.16.144`（NameSilo 停放页）。
> 也就是：域名已买好，但**网站内容槽位是空的**，浏览器现在只会看到域名商的广告页。

---

## 0. 先搞清楚一件事

域名 = 门牌号，不是房子。
`aliceliddell.top` 只负责「把访客指到某台机器」，页面内容存在**托管平台**上。
所以「编辑内容」= 两步：**① 把内容放到托管平台 → ② 把域名指过去**。

改内容的日常操作永远是改本地文件 → 重新上传，不需要再碰 DNS。

---

## 1. 选一条路线

| 路线 | 花费 | 上手难度 | 适合 |
|---|---|---|---|
| **A. Cloudflare Pages** | 免费 | ★☆☆ | 静态页、想最快见效、自带免费 HTTPS |
| **B. GitHub Pages** | 免费 | ★☆☆ | 有 GitHub 账号，想用 git 管版本 |
| **C. 云服务器 + 宝塔** | ¥30–100/月 | ★★★ | 要跑 WordPress / Node / 数据库、要后台管理 |
| **D. NameSilo Website Builder** | $1.99+/月 | ★☆☆ | 完全不想碰技术，拖拽式 |

新手直接走 **A**。

---

## 2. 路线 A：Cloudflare Pages（推荐）

### 2.1 建项目
1. 注册/登录 <https://dash.cloudflare.com/>
2. 左侧 **Workers & Pages** → **Create** → **Pages** → **Upload assets**
3. 项目名填 `aliceliddell`，把本目录（`index.html` / `404.html`）**整个拖进去** → Deploy
4. 拿到临时域名 `aliceliddell.pages.dev`，先确认能打开

### 2.2 把域名接过来
Cloudflare 有两种接法，**推荐第一种**（整站接管，以后证书/DNS 都在一处管）：

**接法一：改 NS 到 Cloudflare**
1. Cloudflare → **Add a site** → 输入 `aliceliddell.top` → 选 Free 计划
2. 它会给你两个 NS，例如 `xxx.ns.cloudflare.com`
3. 回到 NameSilo：**Domain Manager → aliceliddell.top → Change Nameservers**
   把 `ns1/ns2/ns3.dnsowl.com` 换成 Cloudflare 给的那两个
4. 等生效（通常 10 分钟–2 小时，最长 48 小时）
5. 生效后 Cloudflare 里 **DNS → Records** 加：
   ```
   Type: CNAME   Name: @      Target: aliceliddell.pages.dev   Proxied: ✅
   Type: CNAME   Name: www    Target: aliceliddell.pages.dev   Proxied: ✅
   ```
6. **Pages → 你的项目 → Custom domains → Set up a domain** → 填 `aliceliddell.top`，再加 `www.aliceliddell.top`

**接法二：只改 DNS 记录，NS 不动**
在 NameSilo 的 **DNS Manager** 里：
1. **删掉**原来那 3 条停放 A 记录（`172.232.24.161` 等）
2. 新增：
   ```
   CNAME   @     aliceliddell.pages.dev
   CNAME   www   aliceliddell.pages.dev
   ```
   （NameSilo 允许根域名 CNAME，不行就用 Cloudflare）
3. 回 Cloudflare Pages 绑定自定义域名

### 2.3 以后怎么改内容
改本地 `index.html` → Pages 项目 → **Create new deployment** → 重新拖文件夹。
或者接 GitHub 仓库，`git push` 自动发布。

---

## 3. 路线 B：GitHub Pages

```bash
# 1. 建仓库 aliceliddell-top，把 index.html / 404.html 放进去
cd aliceliddell-top-site
git init
git add .
git commit -m "init site"
git branch -M main
git remote add origin https://github.com/<你的用户名>/aliceliddell-top.git
git push -u origin main
```

2. 仓库 **Settings → Pages** → Source 选 `Deploy from a branch` → `main` / `/ (root)` → Save
3. 访问 `https://<用户名>.github.io/aliceliddell-top/` 确认
4. 仓库根目录加文件 `CNAME`，内容一行：
   ```
   aliceliddell.top
   ```
5. NameSilo DNS 加 4 条 A 记录 + 1 条 CNAME：
   ```
   A      @     185.199.108.153
   A      @     185.199.109.153
   A      @     185.199.110.153
   A      @     185.199.111.153
   CNAME  www   <你的用户名>.github.io
   ```
6. Settings → Pages → **Enforce HTTPS** 打勾（证书要等几分钟到 1 小时）

改内容 = `git commit` + `git push`。

---

## 4. 路线 C：云服务器 + 宝塔面板

```bash
# 服务器上（Ubuntu 22.04 / Debian 12 为例）
curl -sSO https://download.bt.cn/install/install_panel.sh && bash install_panel.sh
# 装完会给面板地址、用户名、密码
```

1. 面板 → **网站 → 添加站点** → 域名填 `aliceliddell.top` 和 `www.aliceliddell.top`
2. 网站根目录一般是 `/www/wwwroot/aliceliddell.top/`
3. 上传文件：
   ```bash
   scp index.html 404.html root@<服务器IP>:/www/wwwroot/aliceliddell.top/
   ```
   或在面板 **文件** 里直接拖上去
4. 面板 → **SSL → Let's Encrypt** → 申请证书 → 开启「强制 HTTPS」
5. NameSilo DNS：删停放 A 记录，加
   ```
   A   @     <服务器IP>
   A   www   <服务器IP>
   ```
6. 服务器防火墙/安全组放行 **80、443**

**要 WordPress**：面板 → 软件商店 → 一键部署 WordPress，然后在 `wp-admin` 后台写文章，不用碰文件。

### 中国内地服务器必须备案
服务器在中国大陆（阿里云/腾讯云内地节点）→ 必须先做 **ICP 备案**，否则 80/443 会被拦。
不想备案就买**香港/新加坡/日本**节点，或走路线 A/B。

---

## 5. 路线 D：NameSilo 自带建站

NameSilo 后台 → **Website Builder** → 选模板 → 拖拽编辑 → 发布。
它自动处理 DNS 和证书，但持续收费，且导出/迁移受限。

---

## 6. 验证（三种路线通用）

```powershell
# DNS 是否已指向新地址
Resolve-DnsName aliceliddell.top -Type A

# 站点是否可访问 + 证书是否正常
curl.exe -I https://aliceliddell.top
```

- `Resolve-DnsName` 还返回 `172.232.24.x` → DNS 没生效，继续等或检查记录是否保存
- 返回 `185.199.10x.153` → GitHub Pages ✅ / 返回 Cloudflare IP → Pages ✅ / 返回你的服务器 IP → 服务器 ✅
- `curl -I` 出现 `HTTP/2 200` → 上线成功
- 出现 `curl: (60) SSL certificate problem` → 证书还没签发完，等 10–60 分钟

---

## 7. 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 打开是广告页/停放页 | 旧 A 记录没删 | DNS 里删掉 `172.232.24.*` 三条 |
| 裸域名能开，`www` 打不开 | 少了 `www` 记录 | 补一条 CNAME/A |
| 改了记录没变化 | TTL 缓存 | 等 TTL 过期（当前 3521s ≈ 1 小时），或换 DNS 查询 |
| 证书报错 | 签发中 / 未强制 HTTPS | 等，或重新点一次签发 |
| NameSilo 提示域名锁定 | `client transfer prohibited`，新注册 60 天锁 | 正常，不影响改 DNS，只影响转出注册商 |
| 邮件地址 `hello@aliceliddell.top` 收不到信 | 只配了网页，没配 MX | 用 Cloudflare Email Routing（免费转发）或 Zoho Mail |

---

## 8. 本目录文件

```
aliceliddell-top-site/
├── index.html      # 主页，改文字就搜 "改这里"
├── 404.html        # 404 页
└── DEPLOY.md       # 本手册
```

直接可拖到 Cloudflare Pages / GitHub 仓库 / 服务器网站根目录，无构建步骤、无外部依赖。
