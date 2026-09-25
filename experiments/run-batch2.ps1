# run-batch2.ps1 — 分周期实验执行器 v2（9 平台 + 数据质量门槛）
# 由计划任务调用。主实例（有登录态）以 native-only 模式运行，避免 UA 覆盖导致掉登录。
param(
    [int]$Repeats = 2,
    [int]$CooldownMs = 15000,
    [int]$Port = 9335,
    [switch]$NativeOnly
)

$ErrorActionPreference = 'Continue'
$base = 'D:\dsh-desktop\assets\dsh-sessions'
$expDir = Join-Path $base 'exp'
$logDir = Join-Path $expDir 'batches'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logDir "b2-$stamp.log"
$jsonFile = Join-Path $logDir "b2-$stamp.json"

function Log($m) {
    Add-Content -Path $logFile -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8
}

Log "v2 批次开始 port=$Port repeats=$Repeats cooldown=$CooldownMs nativeOnly=$NativeOnly"

$node = 'D:\node.js的编程必须\node.exe'
if (-not (Test-Path $node)) {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { $node = $c.Source }
}
if (-not (Test-Path $node)) { Log 'FAIL: node not found'; exit 1 }

# 浏览器自检（必要时拉起）
$taskName = if ($Port -eq 9336) { 'DSH-UAExperimentBrowser' } else { 'DSH-ShoppingBrowser' }
$alive = $false
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 6
    if ($r.StatusCode -eq 200) { $alive = $true }
} catch { $alive = $false }
if (-not $alive) {
    Log "CDP $Port 不可达，启动任务 $taskName"
    Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 20
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 8
        if ($r.StatusCode -eq 200) { $alive = $true }
    } catch { $alive = $false }
}
if (-not $alive) { Log "FAIL: CDP $Port 无法启动"; exit 2 }
Log "浏览器在线 (port $Port)"

$nativeFlag = if ($NativeOnly) { 'true' } else { 'false' }
$out = & $node (Join-Path $expDir 'exp-scale2.mjs') $Port $Repeats $CooldownMs $jsonFile $nativeFlag 2>&1
$out | ForEach-Object { Log $_ }

if (Test-Path $jsonFile) {
    $j = Get-Content $jsonFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $qb = $j.qualityBreakdown
    Log ("OK: 质量分解 VALID={0} DEGRADED={1} INVALID={2}" -f $qb.VALID, $qb.DEGRADED, $qb.INVALID_LOW)
    $idx = Join-Path $logDir 'index2.tsv'
    if (-not (Test-Path $idx)) { "timestamp`tfile`tport`tnativeOnly`tvalid`tdegraded`tinvalid" | Set-Content -Path $idx -Encoding UTF8 }
    "$stamp`t$(Split-Path $jsonFile -Leaf)`t$Port`t$nativeFlag`t$($qb.VALID)`t$($qb.DEGRADED)`t$($qb.INVALID_LOW)" | Add-Content -Path $idx -Encoding UTF8
    Log '批次结束'
} else {
    Log 'FAIL: 未生成数据文件'
    exit 3
}
