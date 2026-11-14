// @ts-nocheck
/* 由上一版构建产物恢复：保持原首页设计（恢复用户要求的上一版 UI）。 */
import * as jsx_runtime_1 from 'react/jsx-runtime';
import * as react_1 from 'react';
import * as react_dom_1 from 'react-dom';
import * as store_1 from '../state/store';
import * as params_1 from '../core/params';
import * as filename_1 from '../core/filename';
import * as format_1 from '../core/format';
import * as tweet_1 from '../core/tweet';
import * as media_actions_1 from '../core/media-actions';
import * as ui_1 from '../components/ui';
import * as TweetCard_1 from '../components/TweetCard';
import * as MediaGrid_1 from '../components/MediaGrid';
import * as ParamPanel_1 from '../components/ParamPanel';
import * as ResultCard_1 from '../components/ResultCard';
function HomeSteps() {
    return ((0, jsx_runtime_1.jsxs)("div", { className: "parse-empty-steps", children: [(0, jsx_runtime_1.jsxs)("div", { className: "parse-step", children: [(0, jsx_runtime_1.jsx)("span", { className: "parse-step-index", children: "1" }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("div", { className: "parse-step-title", children: "\u7C98\u8D34\u94FE\u63A5" }), (0, jsx_runtime_1.jsx)("div", { className: "parse-step-desc", children: "x.com / twitter.com \u5747\u53EF" })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "parse-step", children: [(0, jsx_runtime_1.jsx)("span", { className: "parse-step-index", children: "2" }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("div", { className: "parse-step-title", children: "\u9009\u62E9\u5A92\u4F53" }), (0, jsx_runtime_1.jsx)("div", { className: "parse-step-desc", children: "\u52A8\u56FE / \u89C6\u9891 / \u56FE\u7247" })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "parse-step", children: [(0, jsx_runtime_1.jsx)("span", { className: "parse-step-index", children: "3" }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("div", { className: "parse-step-title", children: "\u5BFC\u51FA\u52A8\u56FE" }), (0, jsx_runtime_1.jsx)("div", { className: "parse-step-desc", children: "\u539F\u59CB\u6587\u4EF6\u4E0E\u5BFC\u51FA\u7ED3\u679C\u53EF\u968F\u65F6\u67E5\u770B" })] })] })] }));
}
function SourceReference({ first, count, index, probe, saved }) {
    const [fileProbe, setFileProbe] = (0, react_1.useState)(null);
    const savedPath = saved?.filePath || null;
    (0, react_1.useEffect)(() => {
        let cancelled = false;
        setFileProbe(null);
        if (!savedPath)
            return;
        const bridge = window.desktop;
        if (!bridge || !bridge.media || typeof bridge.media.probeFile !== 'function')
            return;
        bridge.media.probeFile(savedPath).then((value) => {
            if (!cancelled && value)
                setFileProbe(value);
        }).catch(() => { });
        return () => { cancelled = true; };
    }, [savedPath]);
    if (!first)
        return null;
    const effectiveProbe = probe ?? fileProbe;
    const width = effectiveProbe?.width ?? saved?.width ?? first.width ?? null;
    const height = effectiveProbe?.height ?? saved?.height ?? first.height ?? null;
    const durationSec = effectiveProbe?.durationSec ?? saved?.durationSec ?? first.durationSec ?? null;
    const frameCount = effectiveProbe?.frameCount ?? null;
    const fps = effectiveProbe?.fps ?? null;
    const sizeBytes = effectiveProbe?.sizeBytes ?? saved?.sizeBytes ?? null;
    const dimensions = typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0 ? `${width} \u00d7 ${height}` : '—';
    const frames = typeof frameCount === 'number' && frameCount > 0 ? (0, format_1.formatCount)(frameCount) + ' 帧' : '—';
    const kindLabel = (0, tweet_1.mediaKindLabel)(first.kind);
    const fields = [
        ['尺寸', dimensions],
        ['时长', (0, format_1.formatDuration)(durationSec)],
        ['帧数', frames],
        ['帧率', (0, format_1.formatFps)(fps)],
        ['文件大小', (0, format_1.formatSize)(sizeBytes)],
        ['源类型', kindLabel],
    ];
    const note = count > 1 ? '已选 ' + count + ' 个 · 以下为第 1 个参考' : '第 ' + index + ' 个 · 源文件参考';
    return (<div className="convert-source-ref" data-testid="source-reference">
            <div className="convert-source-ref-head">
                <span className="convert-source-ref-title">原始媒体</span>
                <span className="convert-source-ref-note">{note}</span>
            </div>
            <dl className="convert-source-ref-grid">
                {fields.map(([label, value]) => (<div className="convert-source-item" key={label}>
                        <dt>{label}</dt>
                        <dd title={value}>{value}</dd>
                    </div>))}
            </dl>
        </div>);
}
/**
 * 解析流程拆成两个独立页面：
 * - 首页（landing）：链接输入 + 说明 + 三步引导，不渲染媒体/结果；
 * - 结果页（result）：推文 + 全宽媒体列表 + 动图输出，无常驻右栏。
 * 转换操作不常驻，点击批量/单个转换后打开右侧抽屉。
 */
function ParseView() {
    const { ready, settings, info, desktopAvailable, tweet, tweetLoading, tweetError, selectedMediaIds, results, savedMedia, savingMediaIds, jobs, pendingParseUrl, clearPendingParseUrl, fetchTweet, clearTweet, toggleMedia, selectAllMedia, clearSelection, saveMediaList, revealSavedMedia, convertMedia, convertSelected, openOutputDir, setView, newParseNonce, parseScreen, } = (0, store_1.useApp)();
    const { toast } = (0, ui_1.useToast)();
    const [url, setUrl] = (0, react_1.useState)('');
    const [params, setParams] = (0, react_1.useState)(() => (0, params_1.normalizeParams)(settings.defaultParams));
    const [presetId, setPresetId] = (0, react_1.useState)(settings.defaultPresetId);
    const [animFormat, setAnimFormat] = (0, react_1.useState)('gif');
    const [convertTarget, setConvertTarget] = (0, react_1.useState)(null);
    const inputRef = (0, react_1.useRef)(null);
    const settingsApplied = (0, react_1.useRef)(false);
    const consumedPending = (0, react_1.useRef)(null);
    const outputRef = (0, react_1.useRef)(null);
    const previousOutputCount = (0, react_1.useRef)(null);
    const lastOutputTweetId = (0, react_1.useRef)(null);
    const lastNewParseNonce = (0, react_1.useRef)(newParseNonce);
    (0, react_1.useEffect)(() => {
        if (settingsApplied.current || !ready)
            return;
        settingsApplied.current = true;
        const next = (0, params_1.normalizeParams)(settings.defaultParams);
        setParams(next);
        setPresetId((0, params_1.detectPresetId)(next) ?? settings.defaultPresetId);
    }, [ready, settings]);
    // 历史页「去解析」：消费 pendingParseUrl，自动填入并自动解析
    (0, react_1.useEffect)(() => {
        if (!pendingParseUrl)
            return;
        if (consumedPending.current === pendingParseUrl)
            return;
        consumedPending.current = pendingParseUrl;
        setUrl(pendingParseUrl);
        clearPendingParseUrl();
        void fetchTweet(pendingParseUrl);
    }, [pendingParseUrl, clearPendingParseUrl, fetchTweet]);
    // 视图切换会卸载本页；仅在结果页从已解析 tweet 恢复链接，初始解析页保持输入框为空
    (0, react_1.useEffect)(() => {
        if (tweet && !url && parseScreen === 'result')
            setUrl(tweet.url);
    }, [tweet, url, parseScreen]);
    const convertibleCount = tweet ? (0, tweet_1.countConvertibleMedia)(tweet.media) : 0;
    const selectedCount = selectedMediaIds.length;
    const selectedConvertible = tweet
        ? tweet.media.filter((item) => selectedMediaIds.includes(item.id) && (0, tweet_1.isConvertibleKind)(item.kind))
        : [];
    const selectedAllSaved = selectedConvertible.length > 0 &&
        selectedConvertible.every((media) => Boolean((0, media_actions_1.findSavedMedia)(savedMedia, media.id)));
    const selectedMedia = tweet ? tweet.media.filter((item) => selectedMediaIds.includes(item.id)) : [];
    const unsavedSelected = selectedMedia.filter((media) => !(0, media_actions_1.findSavedMedia)(savedMedia, media.id));
    const allSelectedSaved = selectedMedia.length > 0 && unsavedSelected.length === 0;
    const toolsReady = info?.tools?.ready ?? false;
    const saveJobs = (0, react_1.useMemo)(() => jobs.filter((job) => job.kind === 'save'), [jobs]);
    const activeSaveCount = saveJobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
    const saving = activeSaveCount > 0;
    const saveFinishedCount = saveJobs.filter((job) => job.status === 'success' || job.status === 'error' || job.status === 'cancelled').length;
    const drawerTargets = !convertTarget
        ? []
        : convertTarget.mode === 'single'
            ? [convertTarget.media]
            : selectedConvertible;
    // 侧栏「解析新链接」：清空输入并回到初始解析页（保留当前结果，可再点「解析推文」返回）
    (0, react_1.useEffect)(() => {
        if (newParseNonce === lastNewParseNonce.current)
            return;
        lastNewParseNonce.current = newParseNonce;
        setConvertTarget(null);
        setUrl('');
    }, [newParseNonce]);
    // 只在同一推文下「新增转换结果」时滚动到输出区；解析进入/切换视图返回都不滚动
    (0, react_1.useEffect)(() => {
        const tweetId = tweet ? tweet.id : null;
        if (lastOutputTweetId.current !== tweetId || previousOutputCount.current === null) {
            lastOutputTweetId.current = tweetId;
            previousOutputCount.current = results.length;
            return;
        }
        if (results.length > previousOutputCount.current && results.length > 0) {
            const target = outputRef.current;
            if (target && typeof target.scrollIntoView === 'function') {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }
        previousOutputCount.current = results.length;
    }, [results.length, tweet]);
    (0, react_1.useEffect)(() => {
        if (!convertTarget)
            return;
        const onKeyDown = (event) => {
            if (event.key === 'Escape')
                setConvertTarget(null);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [convertTarget]);
    const sourceWidth = (0, react_1.useMemo)(() => {
        if (!tweet)
            return null;
        const widths = tweet.media
            .map((item) => item.width)
            .filter((value) => typeof value === 'number' && value > 0);
        return widths.length > 0 ? Math.max(...widths) : null;
    }, [tweet]);
    const sourceHeight = (0, react_1.useMemo)(() => {
        if (!tweet)
            return null;
        const candidates = tweet.media.filter((item) => typeof item.width === 'number' && item.width > 0 && typeof item.height === 'number' && item.height > 0);
        if (candidates.length === 0)
            return null;
        const widest = candidates.reduce((best, item) => (item.width > best.width ? item : best));
        return widest.height > 0 ? widest.height : null;
    }, [tweet]);
    const fileNamePreview = (0, react_1.useMemo)(() => {
        if (!tweet)
            return null;
        const firstSelected = tweet.media.find((item) => selectedMediaIds.includes(item.id)) ?? tweet.media[0];
        const index = firstSelected ? tweet.media.findIndex((item) => item.id === firstSelected.id) + 1 : 1;
        const targetWidth = params.width ?? firstSelected?.width ?? null;
        const targetHeight = targetWidth && firstSelected?.width
            ? Math.round(((firstSelected.height ?? 0) * targetWidth) / firstSelected.width)
            : firstSelected?.height ?? null;
        return (0, filename_1.buildGifFileName)({
            screenName: tweet.author.screenName,
            tweetId: tweet.id,
            mediaIndex: index,
            width: targetWidth,
            height: targetHeight,
            presetId,
        });
    }, [tweet, selectedMediaIds, params, presetId]);
    (0, react_1.useEffect)(() => {
        const el = inputRef.current;
        if (!el)
            return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 84) + 'px';
    }, [url]);
    const handlePaste = async () => {
        try {
            if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
                throw new Error('clipboard unavailable');
            }
            const text = (await navigator.clipboard.readText()) || '';
            const trimmed = text.trim();
            if (!trimmed) {
                toast('剪贴板里没有文本', 'warning');
                return;
            }
            setUrl(trimmed);
            inputRef.current?.focus();
            toast('已粘贴链接，点击「解析」开始', 'success');
        }
        catch {
            toast('无法读取剪贴板，请点击输入框后按 Ctrl+V 粘贴', 'warning');
            inputRef.current?.focus();
        }
    };
    const submit = (event) => {
        event.preventDefault();
        if (tweetLoading)
            return;
        if (!url.trim()) {
            inputRef.current?.focus();
            toast('先粘贴一条 X 推文链接', 'warning');
            return;
        }
        void fetchTweet(url);
    };
    const sourceUrl = tweet?.url || url;
    const handleCopySourceUrl = async () => {
        const bridge = window.desktop;
        if (!bridge) {
            toast('当前为浏览器预览模式，复制链接需在桌面版进行', 'error');
            return;
        }
        try {
            const response = await bridge.clipboard.writeText(sourceUrl);
            if (response.ok)
                toast('已复制推文链接', 'success');
            else
                toast(response.error || '复制失败', 'error');
        }
        catch (error) {
            toast('复制失败：' + (error instanceof Error ? error.message : String(error)), 'error');
        }
    };
    const selectedMediaList = () => {
        if (!tweet)
            return [];
        return tweet.media.filter((item) => selectedMediaIds.includes(item.id));
    };
    const handleSaveSelected = () => {
        const list = selectedMediaList();
        if (list.length === 0) {
            toast('请先勾选要保存的媒体', 'warning');
            return;
        }
        const unsaved = list.filter((media) => !(0, media_actions_1.findSavedMedia)(savedMedia, media.id));
        if (unsaved.length === 0) {
            toast('所选媒体已全部保存', 'warning');
            return;
        }
        saveMediaList(unsaved);
    };
    const openBatchConvert = () => {
        if (selectedConvertible.length === 0) {
            toast('请先勾选要转换的动图或视频', 'warning');
            return;
        }
        setAnimFormat('gif');
        setConvertTarget({ mode: 'batch' });
    };
    const openSingleConvert = (media) => {
        if (!(0, tweet_1.isConvertibleKind)(media.kind)) {
            toast('图片无需转换，可直接保存', 'warning');
            return;
        }
        setAnimFormat('gif');
        setConvertTarget({ mode: 'single', media });
    };
    const startConvert = () => {
        if (!convertTarget || drawerTargets.length === 0)
            return;
        if (convertTarget.mode === 'single') {
            convertMedia(drawerTargets[0], params, presetId, animFormat);
        }
        else {
            convertSelected(params, presetId, animFormat);
        }
        setConvertTarget(null);
    };
    const mediaOf = (result) => {
        if (!tweet)
            return null;
        return tweet.media.find((item) => item.id === result.mediaId) ?? null;
    };
    const mediaIndex = (media) => {
        if (!tweet || !media)
            return 1;
        return tweet.media.findIndex((item) => item.id === media.id) + 1;
    };
    const notices = ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [!desktopAvailable ? ((0, jsx_runtime_1.jsxs)("div", { className: "notice is-warning", children: [(0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "warning", size: 16 }), (0, jsx_runtime_1.jsx)("div", { children: "\u5F53\u524D\u4E3A\u6D4F\u89C8\u5668\u9884\u89C8\u6A21\u5F0F\uFF1A\u89E3\u6790\u3001\u4FDD\u5B58\u4E0E\u6587\u4EF6\u64CD\u4F5C\u9700\u5728\u684C\u9762\u7248\u4F7F\u7528\uFF1B\u6B64\u9875\u9762\u4EC5\u7528\u4E8E\u754C\u9762\u9884\u89C8\u3002" })] })) : null, desktopAvailable && info && !toolsReady ? ((0, jsx_runtime_1.jsxs)("div", { className: "notice is-danger", children: [(0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "error", size: 16 }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("strong", { children: "\u8F6C\u6362\u7EC4\u4EF6\u7F3A\u5931\uFF1A" }), info.tools?.missing && info.tools.missing.length > 0 ? info.tools.missing.join('、') : '组件状态异常', "\u3002\u8BF7\u6253\u5F00\u8BBE\u7F6E\u68C0\u67E5\u7EC4\u4EF6\u72B6\u6001\uFF0C\u6216\u91CD\u65B0\u5B89\u88C5\u5E94\u7528\u540E\u91CD\u542F\u3002"] }), (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "xs", variant: "subtle", onClick: () => setView('settings'), children: "\u67E5\u770B\u8BBE\u7F6E" })] })) : null] }));
    // ---------- 首页 / 初始解析页（landing） ----------
    if (!tweet || parseScreen === 'home') {
        return ((0, jsx_runtime_1.jsxs)("div", { className: "view parse-view parse-home-view", "data-view": "parse", "data-testid": "parse-home", children: [(0, jsx_runtime_1.jsxs)("header", { className: "page-header parse-page-header", children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("h1", { className: "page-title", children: "\u89E3\u6790\u63A8\u6587" }), (0, jsx_runtime_1.jsx)("p", { className: "page-subtitle", children: "\u89E3\u6790 X \u63A8\u6587\u5A92\u4F53 \u00B7 \u4FDD\u5B58\u539F\u6587\u4EF6 / \u5BFC\u51FA\u52A8\u56FE" })] }), (0, jsx_runtime_1.jsx)("div", { className: "page-actions", children: (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "sm", variant: "secondary", icon: "folder", onClick: () => setView('history'), children: "\u67E5\u770B\u5386\u53F2\u8BB0\u5F55" }) })] }), notices, (0, jsx_runtime_1.jsx)("div", { className: "parse-home", children: (0, jsx_runtime_1.jsxs)("div", { className: "parse-empty parse-home-card", children: [(0, jsx_runtime_1.jsx)("div", { className: "parse-empty-glow" }), (0, jsx_runtime_1.jsx)("div", { className: "parse-empty-icon", children: (0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "bolt", size: 26 }) }), (0, jsx_runtime_1.jsx)("h2", { className: "parse-empty-title", children: "\u7C98\u8D34 X \u94FE\u63A5\uFF0C\u4FDD\u5B58\u539F\u5A92\u4F53\u6216\u5BFC\u51FA\u52A8\u56FE" }), (0, jsx_runtime_1.jsx)("p", { className: "parse-empty-desc", children: "\u8BFB\u53D6\u63A8\u6587\u4E2D\u7684\u52A8\u56FE\u3001\u89C6\u9891\u4E0E\u56FE\u7247\uFF1B\u4FDD\u5B58\u539F\u59CB\u6587\u4EF6\uFF0C\u6216\u5BFC\u51FA GIF / WebP \u52A8\u56FE" }), (0, jsx_runtime_1.jsxs)("form", { className: tweetError ? 'url-card has-error parse-home-form' : 'url-card parse-home-form', onSubmit: submit, children: [(0, jsx_runtime_1.jsxs)("div", { className: "url-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "url-icon", children: (0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "link", size: 17 }) }), (0, jsx_runtime_1.jsx)("textarea", { ref: inputRef, className: "url-input parse-link-textarea", "data-testid": "tweet-url-input", rows: 1, wrap: "soft", spellCheck: false, placeholder: "", value: url, onChange: (event) => setUrl(event.target.value), onInput: (event) => { const el = event.currentTarget; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 84) + "px"; }, onKeyDown: (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }, disabled: tweetLoading, "aria-label": "X \u63A8\u6587\u94FE\u63A5" }), (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "sm", variant: "ghost", icon: "paste", "data-testid": "paste-button", onClick: () => void handlePaste(), disabled: tweetLoading, children: "\u7C98\u8D34" }), (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "md", variant: "primary", icon: tweetLoading ? undefined : 'search', type: "submit", "data-testid": "fetch-button", disabled: tweetLoading || !url.trim() || !desktopAvailable, children: tweetLoading ? ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(ui_1.Spinner, { size: 14 }), "\u89E3\u6790\u4E2D\u2026"] })) : ('解析') })] }), tweetError ? ((0, jsx_runtime_1.jsxs)("div", { className: "url-error", role: "alert", children: [(0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "error", size: 14 }), (0, jsx_runtime_1.jsx)("span", { children: tweetError }), (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "xs", variant: "ghost", onClick: () => void fetchTweet(url), disabled: !url.trim(), children: "\u91CD\u8BD5" })] })) : null, tweetLoading ? ((0, jsx_runtime_1.jsxs)("div", { className: "url-loading", children: [(0, jsx_runtime_1.jsx)("span", { className: "skeleton-line" }), (0, jsx_runtime_1.jsx)("span", { className: "skeleton-line is-short" })] })) : null] }), (0, jsx_runtime_1.jsx)(HomeSteps, {}), (0, jsx_runtime_1.jsxs)("div", { className: "parse-empty-actions", children: [(0, jsx_runtime_1.jsx)(ui_1.Button, { variant: "secondary", icon: "history", onClick: () => setView('history'), children: "\u67E5\u770B\u5386\u53F2\u8BB0\u5F55" }), url.trim() ? ((0, jsx_runtime_1.jsx)(ui_1.Button, { variant: "primary", icon: "search", onClick: () => void fetchTweet(url), disabled: tweetLoading, children: "\u89E3\u6790\u8FD9\u6761\u94FE\u63A5" })) : null] }), (0, jsx_runtime_1.jsxs)("div", { className: "parse-empty-note", children: [(0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "info", size: 13 }), "\u9700\u8981\u5206\u4EAB\u65F6\u518D\u5BFC\u51FA\u52A8\u56FE\uFF1AGIF \u517C\u5BB9\u6027\u6700\u597D\uFF0CWebP \u4F53\u79EF\u66F4\u5C0F\u3001\u753B\u8D28\u66F4\u9AD8"] })] }) })] }));
    }
    // ---------- 结果页（result） ----------
    return ((0, jsx_runtime_1.jsxs)("div", { className: "view parse-view parse-result-view", "data-view": "parse", "data-testid": "parse-result", children: [(0, jsx_runtime_1.jsxs)("header", { className: "page-header parse-page-header", children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsxs)("div", { className: "result-headline", children: [(0, jsx_runtime_1.jsx)("h1", { className: "page-title", children: "\u89E3\u6790\u7ED3\u679C" }), (0, jsx_runtime_1.jsxs)("span", { className: "result-head-badge", children: [tweet.media.length, " \u4E2A\u5A92\u4F53 \u00B7 ", results.length, " \u4E2A\u52A8\u56FE"] })] }), (0, jsx_runtime_1.jsxs)("p", { className: "page-subtitle", children: ["@", tweet.author.screenName, " \u00B7 \u4FDD\u5B58\u539F\u6587\u4EF6\u6216\u5BFC\u51FA\u52A8\u56FE"] })] }), (0, jsx_runtime_1.jsx)("div", { className: "page-actions", children: (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "sm", variant: "secondary", icon: "folder", onClick: () => void openOutputDir(), disabled: !desktopAvailable, children: "\u6253\u5F00\u8F93\u51FA\u76EE\u5F55" }) })] }), notices, (0, jsx_runtime_1.jsxs)("div", { className: "url-card parse-result-url", children: [(0, jsx_runtime_1.jsx)("span", { className: "url-icon", children: (0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "link", size: 15 }) }), (0, jsx_runtime_1.jsx)("div", { className: "parse-result-url-text mono", "data-testid": "result-url-text", title: sourceUrl, children: sourceUrl }), (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "xs", variant: "ghost", icon: "copy", onClick: () => void handleCopySourceUrl(), title: "\u590D\u5236\u63A8\u6587\u94FE\u63A5", children: "\u590D\u5236" }), (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "xs", variant: "secondary", icon: "refresh", onClick: () => void fetchTweet(sourceUrl), disabled: tweetLoading || !sourceUrl.trim(), title: "\u7528\u5F53\u524D\u94FE\u63A5\u91CD\u65B0\u62C9\u53D6", children: "\u5237\u65B0" })] }), (0, jsx_runtime_1.jsx)("section", { className: "parse-result-tweet", "data-section": "source", children: (0, jsx_runtime_1.jsx)(TweetCard_1.TweetCard, { tweet: tweet }) }), (0, jsx_runtime_1.jsxs)("section", { className: "parse-section is-media parse-result-media", "data-section": "media", children: [(0, jsx_runtime_1.jsxs)("div", { className: "parse-media-head", children: [(0, jsx_runtime_1.jsxs)("div", { className: "parse-media-heading", children: [(0, jsx_runtime_1.jsxs)("h2", { className: "parse-media-title", children: ["\u5A92\u4F53", (0, jsx_runtime_1.jsxs)("span", { className: "parse-media-badge", children: [tweet.media.length, " \u4E2A"] })] }), (0, jsx_runtime_1.jsxs)("span", { className: "selection-count", children: ["\u5DF2\u9009 ", (0, jsx_runtime_1.jsx)("strong", { children: selectedCount }), " \u4E2A / ", tweet.media.length, " \u4E2A", (0, jsx_runtime_1.jsxs)("span", { className: "selection-sub", children: ["\uFF08\u53EF\u8F6C\u6362 ", convertibleCount, " \u4E2A\uFF09"] })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "parse-section-actions", children: [(0, jsx_runtime_1.jsx)(ui_1.Button, { size: "xs", variant: "primary", icon: saving ? undefined : allSelectedSaved ? 'check' : 'download', "data-testid": "save-selected-button", "data-saving": saving ? 'true' : 'false', "data-all-saved": allSelectedSaved ? 'true' : 'false', onClick: handleSaveSelected, disabled: saving || selectedCount === 0 || allSelectedSaved || !desktopAvailable, title: saving
                                            ? '正在保存所选媒体…'
                                            : allSelectedSaved
                                                ? '所选媒体均已保存'
                                                : unsavedSelected.length > 0
                                                    ? `保存 ${unsavedSelected.length} 个未保存媒体`
                                                    : '保存所选媒体到输出目录', children: saving ? ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(ui_1.Spinner, { size: 12 }), "\u4FDD\u5B58\u4E2D\u2026\uFF08", saveFinishedCount, "/", saveJobs.length, "\uFF09"] })) : allSelectedSaved ? ((0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: "\u5DF2\u5168\u90E8\u4FDD\u5B58" })) : ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: ["\u4FDD\u5B58\u6240\u9009", selectedCount > 0 ? `（${unsavedSelected.length} 个）` : ''] })) }), (0, jsx_runtime_1.jsxs)(ui_1.Button, { size: "xs", variant: "secondary", icon: "sparkles", "data-testid": "batch-convert-button", onClick: openBatchConvert, disabled: selectedConvertible.length === 0 || !desktopAvailable, title: selectedConvertible.length === 0 ? '请先勾选动图或视频' : '打开转换设置', children: ["\u8F6C\u6362\u4E3A\u52A8\u56FE", selectedConvertible.length > 0 ? `（${selectedConvertible.length} 个）` : ''] }), (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "xs", variant: "ghost", onClick: selectAllMedia, disabled: selectedCount >= tweet.media.length, children: "\u5168\u9009" }), (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "xs", variant: "ghost", onClick: clearSelection, disabled: selectedCount === 0, children: "\u6E05\u7A7A" })] })] }), tweet.media.length > 0 ? ((0, jsx_runtime_1.jsx)(MediaGrid_1.MediaGrid, { tweet: tweet, selectedIds: selectedMediaIds, savedMedia: savedMedia, savingMediaIds: savingMediaIds, onToggle: toggleMedia, onSave: (media) => {
                            const saved = (0, media_actions_1.findSavedMedia)(savedMedia, media.id);
                            saveMediaList([media], Boolean(saved));
                        }, onReveal: (saved) => void revealSavedMedia(saved), onConvert: openSingleConvert, onCopySource: (media) => {
                            const bridge = window.desktop;
                            if (!bridge) {
                                toast('当前不在桌面环境中运行', 'error');
                                return;
                            }
                            void bridge.clipboard
                                .writeText(media.sourceUrl)
                                .then((response) => {
                                if (response.ok)
                                    toast('已复制媒体源链接', 'success');
                                else
                                    toast(response.error || '复制失败', 'error');
                            })
                                .catch((error) => {
                                toast('复制失败：' + (error instanceof Error ? error.message : String(error)), 'error');
                            });
                        } })) : ((0, jsx_runtime_1.jsx)("div", { className: "parse-output-empty", children: "\u8FD9\u6761\u63A8\u6587\u6CA1\u6709\u5A92\u4F53\uFF0C\u6362\u4E00\u6761\u5305\u542B\u52A8\u56FE\u3001\u89C6\u9891\u6216\u56FE\u7247\u7684\u63A8\u6587\u8BD5\u8BD5\u3002" }))] }), (0, jsx_runtime_1.jsxs)("section", { className: "parse-section is-output parse-result-output", "data-section": "output", ref: outputRef, children: [(0, jsx_runtime_1.jsxs)("div", { className: "parse-media-head", children: [(0, jsx_runtime_1.jsx)("div", { className: "parse-media-heading", children: (0, jsx_runtime_1.jsxs)("h2", { className: "parse-media-title", children: ["\u52A8\u56FE\u8F93\u51FA", (0, jsx_runtime_1.jsxs)("span", { className: "parse-media-badge", children: [results.length, " \u4E2A"] })] }) }), (0, jsx_runtime_1.jsx)("div", { className: "parse-section-actions", children: (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "xs", variant: "ghost", icon: "folder", onClick: () => void openOutputDir(), disabled: !desktopAvailable, children: "\u6253\u5F00\u8F93\u51FA\u76EE\u5F55" }) })] }), results.length > 0 ? ((0, jsx_runtime_1.jsx)("div", { className: "gif-card-grid", children: results.map((result) => {
                            const media = mediaOf(result);
                            return ((0, jsx_runtime_1.jsx)(ResultCard_1.ResultCard, { compact: true, result: result, media: media, authorName: tweet.author.screenName, mediaIndex: mediaIndex(media) }, result.id));
                        }) })) : ((0, jsx_runtime_1.jsxs)("div", { className: "parse-output-empty", children: [(0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "info", size: 14 }), "\u8FD8\u6CA1\u6709\u52A8\u56FE\u8F93\u51FA\uFF1B\u52FE\u9009\u5A92\u4F53\u540E\u70B9\u300C\u8F6C\u6362\u4E3A\u52A8\u56FE\u300D\u5E76\u5F00\u59CB\u8F6C\u6362\u3002"] }))] }), convertTarget && drawerTargets.length > 0
                ? (0, react_dom_1.createPortal)((0, jsx_runtime_1.jsx)("div", { className: "convert-drawer-backdrop", onMouseDown: () => setConvertTarget(null), children: (0, jsx_runtime_1.jsxs)("aside", { className: "convert-drawer", "data-testid": "convert-drawer", onMouseDown: (event) => event.stopPropagation(), children: [(0, jsx_runtime_1.jsxs)("header", { className: "convert-drawer-head", children: [(0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "sparkles", size: 16 }), (0, jsx_runtime_1.jsxs)("div", { className: "convert-drawer-heading", children: [(0, jsx_runtime_1.jsx)("div", { className: "convert-drawer-title", children: "\u8F6C\u6362\u4E3A\u52A8\u56FE" }), (0, jsx_runtime_1.jsxs)("div", { className: "convert-drawer-sub", children: [drawerTargets.length, " \u4E2A\u5A92\u4F53", convertTarget.mode === 'single'
                                                        ? ` · 第 ${tweet.media.findIndex((item) => item.id === convertTarget.media.id) + 1} 项 · 源媒体 ${(0, tweet_1.mediaKindLabel)(convertTarget.media.kind)}`
                                                        : (() => {
                                                            const indices = drawerTargets
                                                                .map((media) => tweet.media.findIndex((item) => item.id === media.id) + 1)
                                                                .filter((index) => index > 0);
                                                            return ' · 第 ' + indices.join('、') + ' 项';
                                                        })()] })] }), (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "xs", variant: "ghost", icon: "close", onClick: () => setConvertTarget(null), title: "\u5173\u95ED" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "convert-drawer-body", children: [(0, jsx_runtime_1.jsxs)("div", { className: "convert-format-block", children: [(0, jsx_runtime_1.jsx)("div", { className: "convert-format-label", children: "\u8F93\u51FA\u683C\u5F0F" }), (0, jsx_runtime_1.jsxs)("div", { className: "convert-format-tabs", role: "tablist", "aria-label": "\u8F93\u51FA\u683C\u5F0F", children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", role: "tab", "aria-selected": animFormat === 'gif', "data-testid": "format-tab-gif", className: 'convert-format-tab' + (animFormat === 'gif' ? ' is-active' : ''), onClick: () => setAnimFormat('gif'), children: [(0, jsx_runtime_1.jsxs)("span", { className: "convert-format-tab-head", children: [(0, jsx_runtime_1.jsx)("span", { className: "convert-format-tab-name", children: "GIF" }), animFormat === 'gif' ? ((0, jsx_runtime_1.jsx)("span", { className: "convert-format-tab-check", children: (0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "check", size: 11 }) })) : null] }), (0, jsx_runtime_1.jsx)("span", { className: "convert-format-tab-desc", children: "\u517C\u5BB9\u6027\u6700\u597D\uFF0C\u804A\u5929/\u8BBA\u575B\u901A\u7528" })] }), (0, jsx_runtime_1.jsxs)("button", { type: "button", role: "tab", "aria-selected": animFormat === 'webp', "data-testid": "format-tab-webp", className: 'convert-format-tab' + (animFormat === 'webp' ? ' is-active' : ''), onClick: () => setAnimFormat('webp'), children: [(0, jsx_runtime_1.jsxs)("span", { className: "convert-format-tab-head", children: [(0, jsx_runtime_1.jsx)("span", { className: "convert-format-tab-name", children: "WebP" }), animFormat === 'webp' ? ((0, jsx_runtime_1.jsx)("span", { className: "convert-format-tab-check", children: (0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "check", size: 11 }) })) : null] }), (0, jsx_runtime_1.jsx)("span", { className: "convert-format-tab-desc", children: "\u4F53\u79EF\u66F4\u5C0F\uFF0C\u753B\u8D28\u66F4\u9AD8" })] })] }), animFormat === 'webp' ? ((0, jsx_runtime_1.jsx)("div", { className: "convert-format-hint", "data-testid": "webp-format-hint", children: "\u4F53\u79EF\u7EA6\u4E3A GIF \u7684 1/4\u20131/5\uFF0C\u753B\u8D28\u66F4\u9AD8\uFF1B\u90E8\u5206\u65E7\u7248\u804A\u5929/\u8BBA\u575B\u53EA\u652F\u6301 GIF" })) : null] }), (0, jsx_runtime_1.jsx)("div", { className: "convert-drawer-targets", children: (0, jsx_runtime_1.jsxs)("span", { className: "convert-target-summary", children: ["\u5DF2\u9009 ", drawerTargets.length, " \u4E2A\u5A92\u4F53", drawerTargets.length <= 6
                                                    ? '（第 ' +
                                                        drawerTargets
                                                            .map((media) => tweet.media.findIndex((item) => item.id === media.id) + 1)
                                                            .filter((index) => index > 0)
                                                            .join('、') +
                                                        ' 项）'
                                                    : '', (() => {
                                                    const kinds = Array.from(new Set(drawerTargets.map((media) => media.kind)));
                                                    return kinds.length === 1 ? ' · 源类型 ' + (0, tweet_1.mediaKindLabel)(kinds[0]) : ' · 源类型 混合';
                                                })()] }) }), (0, jsx_runtime_1.jsx)(SourceReference, { first: drawerTargets[0], count: drawerTargets.length, index: tweet.media.findIndex((item) => item.id === drawerTargets[0].id) + 1, probe: results.find((result) => result.mediaId === drawerTargets[0].id)?.sourceProbe ?? null, saved: (0, media_actions_1.findSavedMedia)(savedMedia, drawerTargets[0].id) }), (0, jsx_runtime_1.jsx)(ParamPanel_1.ParamPanel, { variant: "bar", animFormat: animFormat, params: params, presetId: presetId, sourceWidth: sourceWidth, sourceHeight: sourceHeight, fileNamePreview: fileNamePreview, onChange: (next, nextPreset) => {
                                            setParams(next);
                                            setPresetId(nextPreset);
                                        } })] }), (0, jsx_runtime_1.jsxs)("footer", { className: "convert-drawer-footer", children: [(0, jsx_runtime_1.jsx)("span", { className: "convert-drawer-hint", children: "\u8F6C\u6362\u6700\u591A 2 \u4E2A\u4EFB\u52A1\u5E76\u53D1\u6267\u884C\uFF0C\u5176\u4F59\u81EA\u52A8\u6392\u961F\uFF1B\u672A\u4FDD\u5B58\u7684\u6E90\u5A92\u4F53\u4F1A\u81EA\u52A8\u4FDD\u5B58\u3002X \u4E0A\u7684\u52A8\u56FE\u5B9E\u9645\u662F\u89C6\u9891\u6587\u4EF6\uFF0C\u5EFA\u8BAE\u4F18\u5148\u4FDD\u5B58\u539F\u59CB\u6587\u4EF6\uFF0C\u9700\u8981\u5206\u4EAB\u65F6\u518D\u5BFC\u51FA GIF / WebP \u52A8\u56FE\u3002" }), (0, jsx_runtime_1.jsxs)(ui_1.Button, { size: "sm", variant: "primary", icon: "sparkles", className: "convert-drawer-start", "data-testid": "start-convert-button", onClick: startConvert, disabled: !desktopAvailable, children: ["\u5F00\u59CB\u8F6C\u6362\uFF08", drawerTargets.length, " \u4E2A\uFF09"] }), (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "sm", variant: "ghost", className: "convert-drawer-cancel", onClick: () => setConvertTarget(null), children: "\u53D6\u6D88" })] })] }) }), document.body)
                : null] }));
}

export default ParseView;
