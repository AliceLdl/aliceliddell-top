# update-psim.ps1 — 一键把 AliceLdl/president-sim 的最新版本同步到 aliceliddell.top/president-sim/
#
# 用法：
#   .\update-psim.ps1              # 有更新就同步；没更新直接退出
#   .\update-psim.ps1 -Force       # 强制重新部署（即使 blob 相同）
#   .\update-psim.ps1 -Check       # 只检查有没有更新，不改动任何文件
#
# 前置：gh 已登录（gh auth status 通过），站点目录已 git 配好 origin
#
# 注意：本脚本刻意使用 $ErrorActionPreference = 'Continue'。
#       git 和 curl 会把进度/状态写到 stderr，若设为 'Stop'，
#       这些正常输出会被 PowerShell 当成致命错误而中止脚本。
#       所有原生命令改为检查 $LASTEXITCODE。

param(
    [switch]$Force,
    [switch]$Check
)

$ErrorActionPreference = 'Continue'
$Site       = "C:\Users\HUAWEI\Documents\deepseek-harness\default-workspace\aliceliddell-top-site"
$TargetFile = Join-Path $Site "president-sim\index.html"
$SrcRepo    = "AliceLdl/president-sim"
$SrcPath    = "president-sim.html"
$Gh         = "C:\Program Files\GitHub CLI\gh.exe"
$GitName    = "AliceLdl"
$GitEmail   = "alicelidel@foxmail.com"

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

# 执行原生命令并返回退出码；stdout/stderr 一并吞掉，避免污染输出
function RunNative([scriptblock]$block) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $block 2>&1 | Out-Null
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    return $code
}

Say "=== president-sim → aliceliddell.top 同步 ===" Cyan

# --- 1. 凭据 ---
if (-not (Test-Path $Gh)) { Fail "找不到 gh.exe：$Gh" }
$token = (& $Gh auth token 2>&1 | Out-String).Trim()
if (-not $token -or $token -match 'error|not logged') { Fail "gh 未登录，先跑：gh auth login" }
$ApiH = @{
    Authorization = "token $token"
    Accept        = "application/vnd.github+json"
    "User-Agent"  = "update-psim"
}

# --- 2. 源仓库最新状态 ---
Say "`n[1/6] 查询源仓库最新提交…"
try {
    $commit  = Invoke-RestMethod "https://api.github.com/repos/$SrcRepo/commits?per_page=1" -Headers $ApiH
    $srcBlob = Invoke-RestMethod "https://api.github.com/repos/$SrcRepo/contents/$SrcPath" -Headers $ApiH
} catch { Fail "GitHub API 请求失败：$($_.Exception.Message)" }
$srcSha  = $srcBlob.sha
$srcSize = $srcBlob.size
Say ("  commit : {0}  {1}" -f $commit[0].sha.Substring(0,7), $commit[0].commit.message.Split("`n")[0])
Say ("  文件   : {0:N0} 字节   blob={1}" -f $srcSize, $srcSha.Substring(0,8))

# --- 3. 本站当前状态 ---
Say "`n[2/6] 检查站点当前版本…"
Push-Location $Site
try {
    $localBlob = (& git rev-parse "origin/main:president-sim/index.html" 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $localBlob) { Say "  本站尚未部署过该文件" Yellow; $localBlob = "" }
    else { Say ("  已部署 : blob={0}" -f $localBlob.Substring(0,8)) }
} finally { Pop-Location }

if ($localBlob -eq $srcSha -and -not $Force) {
    Say "`n✅ 已是最新版本，无需操作（要强制重发用 -Force）" Green
    exit 0
}

if ($Check) {
    Say "`n🔔 有更新可用（-Check 模式，未做任何改动）" Yellow
    exit 0
}

# --- 4. 下载 ---
Say "`n[3/6] 下载最新文件…"
$tmp = Join-Path $env:TEMP "psim_sync_$(Get-Date -Format HHmmss).html"
$sw = [diagnostics.stopwatch]::StartNew()
curl.exe -sS -L --max-time 600 `
    -H "Authorization: token $token" `
    -H "Accept: application/vnd.github.raw" `
    -H "User-Agent: update-psim" `
    -o $tmp "https://api.github.com/repos/$SrcRepo/contents/$SrcPath" 2>&1 | Out-Null
$sw.Stop()
if (-not (Test-Path $tmp)) { Fail "下载失败：文件未生成" }
$gotSize = (Get-Item $tmp).Length
if ($gotSize -ne $srcSize) {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Fail ("下载不完整：{0:N0} / {1:N0} 字节" -f $gotSize, $srcSize)
}
Say ("  {0:N0} 字节  耗时 {1:N1}s  MD5={2}" -f $gotSize, $sw.Elapsed.TotalSeconds, (Get-FileHash $tmp -Algorithm MD5).Hash)

# 结构自检，防止半截文件上线
$c = [System.IO.File]::ReadAllText($tmp)
if ($c -notmatch '</html>\s*$') { Remove-Item $tmp -Force -ErrorAction SilentlyContinue; Fail "文件结尾不完整（缺 </html>），中止" }
if (([regex]::Matches($c,'<script').Count) -ne ([regex]::Matches($c,'</script>').Count)) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue; Fail "script 标签不配对，中止" }
$title = if ($c -match '<title>\s*([^<]*)</title>') { $matches[1] } else { '(无标题)' }
Say "  结构自检通过，title = $title"

# --- 5. 替换 + 提交 + 推送 ---
Say "`n[4/6] 写入站点目录…"
Copy-Item $tmp $TargetFile -Force
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
Say ("  index.html → {0:N0} 字节" -f (Get-Item $TargetFile).Length)

Say "`n[5/6] 提交并推送…"
Push-Location $Site
try {
    $code = RunNative { git add -A }
    if ($code -ne 0) { Say "  git add 失败 (exit=$code)" Red; exit 1 }

    $msg = "更新总统模拟器到 {0}（{1}）" -f ($title -replace '^总统模拟器\s*',''), $commit[0].sha.Substring(0,7)
    $code = RunNative { git -c user.name=$GitName -c user.email=$GitEmail commit -q -m $msg }
    # commit 退出码 1 表示"无变更可提交"，不算致命
    if ($code -ne 0 -and $code -ne 1) { Say "  git commit 失败 (exit=$code)" Red; exit 1 }

    $code = RunNative { git push origin main }
    if ($code -ne 0) { Say "  git push 失败 (exit=$code)" Red; exit 1 }

    $l = (& git rev-parse main | Out-String).Trim()
    $r = (& git rev-parse origin/main | Out-String).Trim()
    if ($l -ne $r) { Say "  推送后本地与远程不一致：local=$l remote=$r" Red; exit 1 }
    Say ("  已推送 {0}  {1}" -f $l.Substring(0,7), $msg)

    $newBlob = (& git rev-parse "origin/main:president-sim/index.html" | Out-String).Trim()
    if ($newBlob -eq $srcSha) { Say "  ✅ 站点 blob 与源仓库一致（$($srcSha.Substring(0,8))）" Green }
    else { Say "  ⚠️ blob 不一致：站点=$($newBlob.Substring(0,8)) 源=$($srcSha.Substring(0,8))" Yellow }
} finally { Pop-Location }

# --- 6. 等部署 + 验证 ---
Say "`n[6/6] 等待 Cloudflare Pages 部署…"
$ok = $false
for ($i = 1; $i -le 20; $i++) {
    Start-Sleep -Seconds 20
    $code = (curl.exe -sS -o NUL -w "%{http_code}" --max-time 180 --resolve "aliceliddell.top:443:104.21.8.181" "https://aliceliddell.top/president-sim/" 2>$null | Out-String).Trim()
    $size = (curl.exe -sS -o NUL -w "%{size_download}" --max-time 180 --resolve "aliceliddell.top:443:104.21.8.181" "https://aliceliddell.top/president-sim/" 2>$null | Out-String).Trim()
    Say ("  第 {0} 次  code={1}  bytes={2}" -f $i, $code, $size)
    if ($code -eq '200' -and $size -eq "$srcSize") { $ok = $true; break }
}
if ($ok) { Say ("`n✅ 上线完成：https://aliceliddell.top/president-sim/  （{0:N0} 字节）" -f $srcSize) Green }
else { Say "`n⚠️ 部署尚未完成，Cloudflare 构建可能还在跑，稍后手动刷新确认" Yellow }
