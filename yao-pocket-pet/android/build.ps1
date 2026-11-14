param(
    [string]$SdkRoot
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $SdkRoot) {
    if ($env:ANDROID_SDK_ROOT) {
        $SdkRoot = $env:ANDROID_SDK_ROOT
    } elseif ($env:ANDROID_HOME) {
        $SdkRoot = $env:ANDROID_HOME
    } else {
        $adbCommand = Get-Command adb -ErrorAction SilentlyContinue
        if (-not $adbCommand) {
            throw '请设置 ANDROID_SDK_ROOT，或把 Android SDK 的 platform-tools 加入 PATH。'
        }
        $SdkRoot = Split-Path (Split-Path $adbCommand.Source -Parent) -Parent
    }
}

$SdkRoot = (Resolve-Path $SdkRoot).Path
$androidJar = Join-Path $SdkRoot 'platforms\android-35\android.jar'
$buildTools = Join-Path $SdkRoot 'build-tools\35.0.0'
$aapt = Join-Path $buildTools 'aapt.exe'
$d8 = Join-Path $buildTools 'd8.bat'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$apksigner = Join-Path $buildTools 'apksigner.bat'

foreach ($path in @($androidJar, $aapt, $d8, $zipalign, $apksigner)) {
    if (-not (Test-Path $path)) {
        throw "缺少 Android SDK 构建文件：$path"
    }
}

$javac = (Get-Command javac -ErrorAction Stop).Source
$jar = (Get-Command jar -ErrorAction Stop).Source
$keytool = (Get-Command keytool -ErrorAction Stop).Source
$buildRoot = Join-Path $PSScriptRoot 'build'
$assetsRoot = Join-Path $buildRoot 'assets'
$stagedImages = Join-Path $assetsRoot 'assets'
$classRoot = Join-Path $buildRoot 'classes'
$classJar = Join-Path $buildRoot 'main-classes.jar'
$dexRoot = Join-Path $buildRoot 'dex'
$unsignedApk = Join-Path $buildRoot 'yao-pocket-pet-unsigned.apk'
$alignedApk = Join-Path $buildRoot 'yao-pocket-pet-aligned.apk'
$debugKey = Join-Path $buildRoot 'debug.keystore'
$outputApk = Join-Path $buildRoot 'yao-pocket-pet.apk'
$manifest = Join-Path $PSScriptRoot 'src\main\AndroidManifest.xml'
$javaSource = Join-Path $PSScriptRoot 'src\main\java\com\tinderbox\yaopocketpet\MainActivity.java'

New-Item -ItemType Directory -Force -Path $assetsRoot, $stagedImages, $classRoot, $dexRoot | Out-Null
Copy-Item (Join-Path $projectRoot 'index.html') $assetsRoot -Force
Copy-Item (Join-Path $projectRoot 'styles.css') $assetsRoot -Force
Copy-Item (Join-Path $projectRoot 'app.js') $assetsRoot -Force
Copy-Item (Join-Path $projectRoot 'assets\*') $stagedImages -Recurse -Force

& $javac -encoding UTF-8 -source 8 -target 8 -classpath $androidJar -d $classRoot $javaSource
if ($LASTEXITCODE -ne 0) { throw "javac 失败，退出码 $LASTEXITCODE" }

& $jar cf $classJar -C $classRoot .
if ($LASTEXITCODE -ne 0) { throw "打包 Java 类失败，退出码 $LASTEXITCODE" }

$classesDex = Join-Path $dexRoot 'classes.dex'
if (Test-Path $classesDex) { Remove-Item $classesDex -Force }
& $d8 --lib $androidJar --min-api 23 --output $dexRoot $classJar
if ($LASTEXITCODE -ne 0) { throw "D8 失败，退出码 $LASTEXITCODE" }

& $aapt package -f -M $manifest -I $androidJar -F $unsignedApk -A $assetsRoot --min-sdk-version 23 --target-sdk-version 28 --version-code 8 --version-name 1.7
if ($LASTEXITCODE -ne 0) { throw "aapt 失败，退出码 $LASTEXITCODE" }

& $jar uf $unsignedApk -C $dexRoot classes.dex
if ($LASTEXITCODE -ne 0) { throw "写入 classes.dex 失败，退出码 $LASTEXITCODE" }

& $zipalign -f 4 $unsignedApk $alignedApk
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败，退出码 $LASTEXITCODE" }

if (-not (Test-Path $debugKey)) {
    & $keytool -genkeypair -noprompt -keystore $debugKey -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Android Debug,O=Android,C=US'
    if ($LASTEXITCODE -ne 0) { throw "生成本地调试签名失败，退出码 $LASTEXITCODE" }
}

& $apksigner sign --ks $debugKey --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out $outputApk $alignedApk
if ($LASTEXITCODE -ne 0) { throw "APK 签名失败，退出码 $LASTEXITCODE" }

& $apksigner verify --verbose $outputApk
if ($LASTEXITCODE -ne 0) { throw "APK 验签失败，退出码 $LASTEXITCODE" }

Write-Output "APK 已生成：$outputApk"
