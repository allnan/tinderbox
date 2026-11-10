package com.endfield.tools.endfield_resources_tools

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var discoveryLock: WifiManager.MulticastLock? = null

    override fun onStart() {
        super.onStart()
        discoveryLock = applicationContext.getSystemService(WifiManager::class.java)
            ?.createMulticastLock("endfield-ledger-discovery")
            ?.apply { acquire() }
    }

    override fun onStop() {
        discoveryLock?.release()
        discoveryLock = null
        super.onStop()
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "com.endfield.tools/platform"
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "dataDirectory" -> result.success(noBackupFilesDir.absolutePath)
                "deviceName" -> result.success(Build.MODEL)
                "openUrl" -> {
                    val uri = call.argument<String>("url")?.let(Uri::parse)
                    if (uri?.scheme != "https") {
                        result.error("invalid_url", "只支持 HTTPS 链接", null)
                        return@setMethodCallHandler
                    }
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                        result.success(null)
                    } catch (_: ActivityNotFoundException) {
                        result.error("browser_unavailable", "未找到可用浏览器", null)
                    }
                }
                else -> result.notImplemented()
            }
        }
    }
}
