# 把便携版 exe 投放到 .deploy-target 指定的目录；结束运行实例，只替换 exe，保留同级 userdata。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "release\MemeVault.exe"
$config = Join-Path $root ".deploy-target"

if (-not (Test-Path $source)) {
  throw "release\MemeVault.exe 不存在，请先运行 npm run build"
}

$targetDir = $env:MEME_VAULT_DEPLOY_DIR
if (-not $targetDir) {
  if (-not (Test-Path $config)) {
    throw "缺少 .deploy-target，请写入投放目录，或设置 MEME_VAULT_DEPLOY_DIR"
  }
  $targetDir = (Get-Content -LiteralPath $config -Raw -Encoding UTF8).Trim()
}
if (-not $targetDir) { throw "投放目录为空" }

$target = Join-Path $targetDir "MemeVault.exe"
Get-Process MemeVault,meme-vault -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 400
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force
Write-Output ("Deployed: " + $target)

