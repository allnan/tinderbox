package com.tinderbox.yaopocketpet;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.regex.Matcher;

public final class MainActivity extends Activity {
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(238, 229, 212));
        getWindow().setNavigationBarColor(Color.rgb(36, 47, 43));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(255, 250, 240));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDefaultTextEncodingName("UTF-8");

        setContentView(webView);
        try {
            String html = readAsset("index.html");
            String css = readAsset("styles.css");
            String js = readAsset("app.js");
            String animationSheet = "data:image/png;base64,"
                    + Base64.encodeToString(readAssetBytes("assets/yao-actions-4x4.png"), Base64.NO_WRAP);
            css = css.replace("url('./assets/yao-actions-4x4.png')", "url('" + animationSheet + "')");
            js = js.replace("if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {",
                    "if (false) {");
            html = html.replaceAll("(?s)<link\\s+rel=\"manifest\"[^>]*>\\s*", "")
                    .replaceAll("(?s)<link\\s+rel=\"icon\"[^>]*>\\s*", "")
                    .replaceAll("(?s)<link\\s+rel=\"stylesheet\"\\s+href=\"\\./styles\\.css\"\\s*/>",
                            Matcher.quoteReplacement("<style>\n" + css + "\n</style>"))
                    .replaceAll("(?s)<script\\s+src=\"\\./app\\.js\"\\s+defer></script>",
                            Matcher.quoteReplacement("<script>\n" + js + "\n</script>"));
            webView.loadDataWithBaseURL(
                    "https://appassets.androidplatform.net/",
                    html,
                    "text/html",
                    "UTF-8",
                    null);
        } catch (IOException exception) {
            webView.loadDataWithBaseURL(
                    null,
                    "<meta charset=\"utf-8\"><p>阿咬宠物机启动失败，请重新安装。</p>",
                    "text/html",
                    "UTF-8",
                    null);
        }
    }

    private String readAsset(String name) throws IOException {
        return new String(readAssetBytes(name), "UTF-8");
    }

    private byte[] readAssetBytes(String name) throws IOException {
        try (InputStream input = getAssets().open(name);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
