// @ts-nocheck
/* 由构建产物恢复（2026-11-12）；参数面板行为保持不变，后续逐步迁移为 TSX。 */
import * as jsx_runtime_1 from 'react/jsx-runtime';
import * as react_1 from 'react';
import * as presets_1 from '../shared/presets';
import * as params_1 from '../core/params';
import * as ui_1 from './ui';
import type { AnimFormat, GifParams } from '../shared/types';
const FPS_OPTIONS = [8, 10, 12, 15, 20, 24, 25, 30, 50, 60];
const COLOR_OPTIONS = [32, 64, 96, 128, 192, 256];
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const LOOP_OPTIONS = [-1, 0, 1, 2, 3, 5, 10];
/** WebP 预设说明：不出现 gifski / 调色板等 GIF 专属术语 */
const WEBP_PRESET_DESCRIPTIONS = {
    source: '保留全部分辨率与逐帧时序，WebP 体积更小、画质更高（推荐）',
    balanced: '原始分辨率与逐帧时序，画质与体积平衡',
    small: '宽度 ≤480，WebP 体积小，适合聊天表情',
    tiny: '宽度 ≤360、15fps，适合体积敏感场景',
};
function withCurrent(options, current) {
    if (options.includes(current))
        return options;
    return [...options, current].sort((a, b) => a - b);
}
/** 给 range 轨道设置已选比例（CSS 变量） */
function rangeProgress(value, min, max) {
    const ratio = (value - min) / Math.max(1, max - min);
    return Math.round(Math.min(1, Math.max(0, ratio)) * 100) + '%';
}
function selectOptions(values, suffix) {
    return values.map((item) => ({ value: String(item), label: item + suffix }));
}
/**
 * 导出参数面板：
 * - full：4 预设卡片 + 高级参数折叠（结果卡复用）；
 * - bar：4 预设 chip + 高级参数折叠（解析页「导出设置」使用，默认收起）。
 * 参数默认值/预设全部来自 src/shared/presets.ts，不在此写死。
 */
function ParamPanel({ params, presetId, onChange, sourceWidth, sourceHeight, fileNamePreview, compact, defaultAdvancedOpen = false, animFormat = 'gif', variant = 'full', }: {
    params: GifParams;
    presetId: string | null;
    onChange: (params: GifParams, presetId: string | null) => void;
    sourceWidth?: number | null;
    sourceHeight?: number | null;
    fileNamePreview?: string | null;
    compact?: boolean;
    defaultAdvancedOpen?: boolean;
    animFormat?: AnimFormat;
    variant?: 'full' | 'bar';
}) {
    const isBar = variant === 'bar';
    const source = typeof sourceWidth === 'number' && sourceWidth > 0 ? sourceWidth : null;
    const sourceH = typeof sourceHeight === 'number' && sourceHeight > 0 ? sourceHeight : null;
    const aspectRatio = source && sourceH ? sourceH / source : null;
    const [advancedOpen, setAdvancedOpen] = (0, react_1.useState)(!isBar || defaultAdvancedOpen);
    const [widthText, setWidthText] = (0, react_1.useState)(params.width ? String(params.width) : '');
    const [sizeMode, setSizeMode] = (0, react_1.useState)('px');
    const [percentText, setPercentText] = (0, react_1.useState)('');
    const percentInputRef = (0, react_1.useRef)(null);
    const widthInputRef = (0, react_1.useRef)(null);
    const heightInputRef = (0, react_1.useRef)(null);
    const percentHeightInputRef = (0, react_1.useRef)(null);
    const sizeHandlersRef = (0, react_1.useRef)({});
    (0, react_1.useEffect)(() => {
        setWidthText(params.width ? String(params.width) : '');
    }, [params.width]);
    (0, react_1.useEffect)(() => {
        if (sizeMode !== 'percent')
            return;
        if (percentInputRef.current && document.activeElement === percentInputRef.current)
            return;
        setPercentText(String((0, params_1.percentFromWidth)(params.width, source)));
    }, [params.width, source, sizeMode]);
    const update = (next) => {
        const merged = (0, params_1.clampParams)({ ...params, ...next }, sourceWidth);
        onChange(merged, (0, params_1.detectPresetId)(merged));
    };
    // WebP 不支持 gifsicle 极限压缩，切换格式时自动关闭
    (0, react_1.useEffect)(() => {
        if (animFormat !== 'webp' || !params.optimize)
            return;
        const merged = (0, params_1.clampParams)({ ...params, optimize: false }, sourceWidth);
        onChange(merged, (0, params_1.detectPresetId)(merged));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [animFormat, params.optimize]);
    const presetDescription = (preset) => {
        const base = animFormat === 'webp'
            ? (WEBP_PRESET_DESCRIPTIONS[preset.id] ?? preset.description)
            : preset.description;
        if (preset.maxLongSide && source && sourceH) {
            const width = (0, params_1.presetWidthForSource)(source, sourceH, preset.maxLongSide);
            if (width !== null)
                return base + '（当前约 ' + width + 'px 宽）';
        }
        return base;
    };
    const applyPreset = (id) => {
        const preset = presets_1.GIF_PRESETS.find((item) => item.id === id);
        if (!preset)
            return;
        const base = { ...preset.params };
        if (preset.maxLongSide && source && sourceH) {
            const width = (0, params_1.presetWidthForSource)(source, sourceH, preset.maxLongSide);
            if (width !== null)
                base.width = width;
        }
        const merged = (0, params_1.clampParams)(base, sourceWidth);
        onChange(merged, preset.id);
    };
    const fps = typeof params.fps === 'number' ? params.fps : null;
    const fpsChoices = withCurrent(FPS_OPTIONS, fps ?? 30);
    const summary = (0, params_1.summarizeParams)(params, presetId, animFormat);
    const encoderRow = ((0, jsx_runtime_1.jsxs)("div", { className: "param-row", "data-testid": "encoder-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "param-label", children: "\u7F16\u7801\u5668" }), (0, jsx_runtime_1.jsx)(ui_1.Segmented, { size: "sm", value: params.encoder, options: [
                    { value: 'gifski', label: 'gifski', title: '高质量 GIF 编码器（推荐）' },
                    { value: 'ffmpeg', label: 'ffmpeg', title: '备选两遍调色板编码' },
                ], onChange: (value) => update({ encoder: value }) })] }, "encoder"));
    const widthRow = ((0, jsx_runtime_1.jsxs)("div", { className: "param-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "param-label", children: "\u5BBD\u5EA6\u4E0A\u9650" }), (0, jsx_runtime_1.jsxs)("div", { className: "param-inline", children: [(0, jsx_runtime_1.jsx)("input", { className: "input param-number", type: "number", min: presets_1.PARAM_LIMITS.widthMin, max: presets_1.PARAM_LIMITS.widthMax, placeholder: "\u539F\u59CB\u5BBD\u5EA6", value: widthText, onChange: (event) => {
                            const text = event.target.value;
                            setWidthText(text);
                            if (text.trim() === '')
                                update({ width: null });
                            else if (Number.isFinite(Number(text)))
                                update({ width: Number(text) });
                        } }), (0, jsx_runtime_1.jsx)("span", { className: "param-unit", children: "px" }), (0, jsx_runtime_1.jsx)(ui_1.Button, { size: "xs", variant: "ghost", onClick: () => update({ width: null }), disabled: params.width === null, children: "\u539F\u59CB\u5BBD\u5EA6" })] })] }, "width"));
    const fpsRow = ((0, jsx_runtime_1.jsxs)("div", { className: "param-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "param-label", children: "\u5E27\u7387" }), (0, jsx_runtime_1.jsx)(ui_1.Select, { className: "param-select", value: params.fps === 'source' ? 'source' : String(params.fps), onChange: (event) => {
                    const value = event.target.value;
                    update({ fps: value === 'source' ? 'source' : Number(value) });
                }, options: [
                    { value: 'source', label: '源帧率（逐帧还原）' },
                    ...fpsChoices.map((item) => ({ value: String(item), label: item + ' fps' })),
                ] })] }, "fps"));
    const colorsRow = ((0, jsx_runtime_1.jsxs)("div", { className: "param-row", "data-testid": "colors-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "param-label", children: "\u989C\u8272\u6570" }), (0, jsx_runtime_1.jsx)(ui_1.Select, { className: "param-select", value: String(params.colors), onChange: (event) => update({ colors: Number(event.target.value) }), options: selectOptions(withCurrent(COLOR_OPTIONS, params.colors), ' 色') })] }, "colors"));
    const qualityRow = ((0, jsx_runtime_1.jsxs)("div", { className: "param-row is-slider", children: [(0, jsx_runtime_1.jsxs)("span", { className: "param-label", children: ["\u8D28\u91CF ", (0, jsx_runtime_1.jsx)("span", { className: "param-value mono", children: Math.round(params.quality) })] }), (0, jsx_runtime_1.jsx)("input", { className: "range", type: "range", min: presets_1.PARAM_LIMITS.qualityMin, max: presets_1.PARAM_LIMITS.qualityMax, step: 1, value: params.quality, style: { ['--range-progress']: rangeProgress(params.quality, presets_1.PARAM_LIMITS.qualityMin, presets_1.PARAM_LIMITS.qualityMax) }, onChange: (event) => update({ quality: Number(event.target.value) }) }), (0, jsx_runtime_1.jsx)("span", { className: "param-hint", children: "\u8D28\u91CF\u8D8A\u9AD8\u8D8A\u6E05\u6670\uFF0C\u4F53\u79EF\u4E5F\u8D8A\u5927" })] }, "quality"));
    const optimizeRow = ((0, jsx_runtime_1.jsxs)("div", { className: "param-row is-switch", "data-testid": "optimize-row", children: [(0, jsx_runtime_1.jsxs)("span", { className: "param-label", children: ["\u6781\u9650\u538B\u7F29", (0, jsx_runtime_1.jsx)("span", { className: "param-label-sub", children: animFormat === 'webp' ? '（WebP 下不可用，仅 GIF 生效）' : '（有损，可能偏色）' })] }), (0, jsx_runtime_1.jsx)(ui_1.Switch, { checked: params.optimize, disabled: animFormat === 'webp', onChange: (value) => update({ optimize: value }) })] }, "optimize"));
    const lossyRow = params.optimize ? ((0, jsx_runtime_1.jsxs)("div", { className: "param-row is-slider", children: [(0, jsx_runtime_1.jsxs)("span", { className: "param-label", children: ["lossy \u5F3A\u5EA6 ", (0, jsx_runtime_1.jsx)("span", { className: "param-value mono", children: Math.round(params.lossy) })] }), (0, jsx_runtime_1.jsx)("input", { className: "range", type: "range", min: presets_1.PARAM_LIMITS.lossyMin, max: presets_1.PARAM_LIMITS.lossyMax, step: 5, value: params.lossy, style: { ['--range-progress']: rangeProgress(params.lossy, presets_1.PARAM_LIMITS.lossyMin, presets_1.PARAM_LIMITS.lossyMax) }, onChange: (event) => update({ lossy: Number(event.target.value) }) }), (0, jsx_runtime_1.jsx)("span", { className: "param-hint", children: "0 \u8868\u793A\u5173\u95ED\uFF1B\u6570\u503C\u8D8A\u5927\u4F53\u79EF\u8D8A\u5C0F\u3001\u504F\u8272\u8D8A\u660E\u663E" })] }, "lossy")) : null;
    const optimizeWarning = params.optimize ? ((0, jsx_runtime_1.jsxs)("div", { className: "param-warning", children: [(0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "warning", size: 14 }), (0, jsx_runtime_1.jsx)("span", { children: "\u6781\u9650\u538B\u7F29\u4F1A\u542F\u7528 gifsicle \u5168\u5C40\u91CF\u5316\uFF0C\u53EF\u80FD\u9020\u6210\u989C\u8272\u504F\u5DEE\uFF0C\u4EC5\u7528\u4E8E\u5BF9\u4F53\u79EF\u6781\u5176\u654F\u611F\u7684\u573A\u666F\uFF1B\u9ED8\u8BA4\u4E0D\u5F00\u542F\uFF0C\u4E5F\u4E0D\u662F\u63A8\u8350\u9009\u9879\u3002" })] }, "optimize-warning")) : null;
    const preserveRow = ((0, jsx_runtime_1.jsxs)("div", { className: "param-row is-switch", children: [(0, jsx_runtime_1.jsx)("span", { className: "param-label", children: "\u9010\u5E27\u65F6\u5E8F\u8FD8\u539F" }), (0, jsx_runtime_1.jsx)(ui_1.Switch, { checked: params.preserveTiming, onChange: (value) => update({ preserveTiming: value }) })] }, "preserve"));
    const ditherRow = ((0, jsx_runtime_1.jsxs)("div", { className: "param-row", "data-testid": "dither-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "param-label", children: "\u6296\u52A8\u65B9\u5F0F" }), (0, jsx_runtime_1.jsx)(ui_1.Select, { className: "param-select", value: params.dither, disabled: params.encoder !== 'ffmpeg', onChange: (event) => update({ dither: event.target.value }), options: [
                    { value: 'sierra2_4a', label: 'Sierra2_4a（推荐）' },
                    { value: 'bayer', label: 'Bayer' },
                    { value: 'none', label: '无抖动' },
                ] })] }, "dither"));
    const ditherHint = params.encoder !== 'ffmpeg' ? ((0, jsx_runtime_1.jsx)("div", { className: "param-hint param-hint-block", children: "gifski \u7F16\u7801\u65F6\u6296\u52A8\u7531\u7F16\u7801\u5668\u5185\u90E8\u5904\u7406\uFF0C\u8BE5\u9009\u9879\u4EC5\u5BF9 ffmpeg \u751F\u6548\u3002" }, "dither-hint")) : null;
    const speedRow = ((0, jsx_runtime_1.jsxs)("div", { className: "param-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "param-label", children: "\u64AD\u653E\u901F\u5EA6" }), (0, jsx_runtime_1.jsx)(ui_1.Select, { className: "param-select", value: String(params.speed), onChange: (event) => update({ speed: Number(event.target.value) }), options: SPEED_OPTIONS.map((item) => ({ value: String(item), label: item === 1 ? '原速' : item + '×' })) })] }, "speed"));
    const loopRow = ((0, jsx_runtime_1.jsxs)("div", { className: "param-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "param-label", children: "\u5FAA\u73AF" }), (0, jsx_runtime_1.jsx)(ui_1.Select, { className: "param-select", value: String(params.loopCount), onChange: (event) => update({ loopCount: Number(event.target.value) }), options: LOOP_OPTIONS.map((item) => ({
                    value: String(item),
                    label: item < 0 ? '不循环（只播放一次）' : item === 0 ? '无限循环' : item === 1 ? '播放 1 次' : item + ' 次',
                })) })] }, "loop"));
    const filePreview = fileNamePreview ? ((0, jsx_runtime_1.jsxs)("div", { className: "param-file-preview", title: fileNamePreview, children: [(0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "file", size: 13 }), (0, jsx_runtime_1.jsx)("span", { className: "mono", children: fileNamePreview })] }, "file-preview")) : null;
    const note = ((0, jsx_runtime_1.jsxs)("div", { className: "param-note", children: [(0, jsx_runtime_1.jsx)(ui_1.Icon, { name: "info", size: 13 }), (0, jsx_runtime_1.jsx)("span", { children: animFormat === 'webp'
                    ? 'WebP 动图体积更小、画质更高，适合网页与新版聊天软件；部分旧版聊天/论坛只支持 GIF，请按目标平台选择。'
                    : 'GIF 体积主要取决于分辨率 × 帧数 × 颜色数以及画面复杂度；同等观感下通常为源视频的 10 倍以上，以实际转换结果为准。' })] }, "note"));
    const switchSizeMode = (mode) => {
        if (mode === sizeMode)
            return;
        if (mode === 'percent') {
            setPercentText(String((0, params_1.percentFromWidth)(params.width, source)));
        }
        else {
            setWidthText(params.width ? String(params.width) : '');
        }
        setSizeMode(mode);
    };
    const percentValue = (() => {
        const parsed = Number(percentText);
        return Number.isFinite(parsed) ? Math.min(100, Math.max(10, parsed)) : (0, params_1.percentFromWidth)(params.width, source);
    })();
    const percentPx = source ? (0, params_1.widthFromPercent)(source, percentValue) : null;
    const adjustWidthPx = (delta) => {
        const max = source ?? presets_1.PARAM_LIMITS.widthMax;
        const current = Number(widthText) || params.width || source || presets_1.PARAM_LIMITS.widthMin;
        const next = Math.min(max, Math.max(presets_1.PARAM_LIMITS.widthMin, Math.round(current + delta)));
        setWidthText(String(next));
        update({ width: next });
    };
    const adjustWidthPercent = (delta) => {
        if (!source)
            return;
        const current = Number(percentText);
        const base = Number.isFinite(current) ? current : (0, params_1.percentFromWidth)(params.width, source);
        const next = Math.min(100, Math.max(10, base + delta));
        setPercentText(String(next));
        update({ width: (0, params_1.widthFromPercent)(source, next) });
    };
    /** 输入过程中不强制收敛，失焦/回车时才校验并写回参数，避免输入 160 时被最小值打断 */
    const commitWidthText = (raw) => {
        const text = String(raw ?? widthText).trim();
        if (!text) {
            setWidthText('');
            update({ width: null });
            return;
        }
        const parsed = Number(text);
        if (!Number.isFinite(parsed)) {
            setWidthText(params.width ? String(params.width) : '');
            return;
        }
        const max = source ?? presets_1.PARAM_LIMITS.widthMax;
        const next = Math.max(presets_1.PARAM_LIMITS.widthMin, Math.min(max, Math.round(parsed)));
        setWidthText(String(next));
        update({ width: next });
    };
    const commitPercentText = (raw) => {
        if (!source)
            return;
        const text = String(raw ?? percentText).trim();
        const parsed = text ? Number(text) : NaN;
        if (!Number.isFinite(parsed)) {
            setPercentText(String((0, params_1.percentFromWidth)(params.width, source)));
            return;
        }
        const pct = Math.max(10, Math.min(100, Math.round(parsed)));
        setPercentText(String(pct));
        update({ width: (0, params_1.widthFromPercent)(source, pct) });
    };
    const outputHeight = params.width && aspectRatio ? Math.max(2, Math.round(params.width * aspectRatio)) : sourceH;
    const stepOptions = sizeMode === 'px' ? [-100, -20, -5, -1, 1, 5, 20, 100] : [-20, -10, -5, -1, 1, 5, 10, 20];
    const applyHeightValue = (nextHeight) => {
        if (!aspectRatio || !sourceH) return;
        const parsed = Number(nextHeight);
        if (!Number.isFinite(parsed)) return;
        const clamped = Math.max(2, Math.min(parsed, sourceH));
        const maxWidth = source ?? presets_1.PARAM_LIMITS.widthMax;
        const width = Math.min(maxWidth, Math.max(presets_1.PARAM_LIMITS.widthMin, Math.round(clamped / aspectRatio)));
        setWidthText(String(width));
        update({ width });
    };
    const applyStep = (delta) => {
        if (sizeMode === 'px') adjustWidthPx(delta);
        else adjustWidthPercent(delta);
    };
    const nudgeSize = (direction) => {
        if (sizeMode === 'px') adjustWidthPx(direction);
        else adjustWidthPercent(direction);
    };
    sizeHandlersRef.current = {
        widthWheel: (event) => {
            event.preventDefault();
            event.stopPropagation();
            nudgeSize(event.deltaY < 0 ? 1 : -1);
        },
        widthKey: (event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')
                return;
            event.preventDefault();
            event.stopPropagation();
            nudgeSize((event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1));
        },
        heightWheel: (event) => {
            if (!outputHeight || !aspectRatio)
                return;
            event.preventDefault();
            event.stopPropagation();
            applyHeightValue(outputHeight + (event.deltaY < 0 ? 2 : -2));
        },
        heightKey: (event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')
                return;
            event.preventDefault();
            event.stopPropagation();
            if (outputHeight)
                applyHeightValue(outputHeight + (event.key === 'ArrowUp' ? 2 : -2) * (event.shiftKey ? 5 : 1));
        },
        heightPercentWheel: (event) => {
            event.preventDefault();
            event.stopPropagation();
            adjustWidthPercent(event.deltaY < 0 ? 1 : -1);
        },
    };
    (0, react_1.useEffect)(() => {
        const widthEl = widthInputRef.current;
        const heightEl = heightInputRef.current;
        const percentHeightEl = percentHeightInputRef.current;
        const widthWheel = (event) => sizeHandlersRef.current.widthWheel(event);
        const widthKey = (event) => sizeHandlersRef.current.widthKey(event);
        const heightWheel = (event) => sizeHandlersRef.current.heightWheel(event);
        const heightKey = (event) => sizeHandlersRef.current.heightKey(event);
        const heightPercentWheel = (event) => sizeHandlersRef.current.heightPercentWheel(event);
        widthEl?.addEventListener('wheel', widthWheel, { passive: false });
        widthEl?.addEventListener('keydown', widthKey);
        heightEl?.addEventListener('wheel', heightWheel, { passive: false });
        heightEl?.addEventListener('keydown', heightKey);
        percentHeightEl?.addEventListener('wheel', heightPercentWheel, { passive: false });
        return () => {
            widthEl?.removeEventListener('wheel', widthWheel);
            widthEl?.removeEventListener('keydown', widthKey);
            heightEl?.removeEventListener('wheel', heightWheel);
            heightEl?.removeEventListener('keydown', heightKey);
            percentHeightEl?.removeEventListener('wheel', heightPercentWheel);
        };
    }, [advancedOpen, sizeMode]);

    const sizeEditor = !source ? (
        <div className="size-editor is-no-source">
            <div className="size-no-source-row">
                <label className="size-dim-field">
                    <span className="size-dim-label">默认宽度</span>
                    <input
                        className="input param-number size-dim-input"
                        data-testid="width-pixel-input"
                        type="number"
                        min={presets_1.PARAM_LIMITS.widthMin}
                        max={presets_1.PARAM_LIMITS.widthMax}
                        placeholder="自动"
                        value={widthText}
                        onChange={(event) => setWidthText(event.target.value)}
                        onBlur={(event) => commitWidthText(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                event.preventDefault();
                                adjustWidthPx((event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1));
                                return;
                            }
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                commitWidthText();
                            }
                        }}
                        onWheel={(event) => {
                            event.preventDefault();
                            adjustWidthPx(event.deltaY < 0 ? 1 : -1);
                        }}
                    />
                    <span className="param-unit">px</span>
                </label>
                <button
                    type="button"
                    className="size-reset-btn is-icon"
                    data-testid="size-reset"
                    title="恢复默认宽度"
                    aria-label="恢复默认宽度"
                    onClick={() => {
                        setWidthText('');
                        update({ width: null });
                    }}
                >
                    <ui_1.Icon name="refresh" size={13} />
                </button>
            </div>
            <div className="size-steps-row" role="group" aria-label="尺寸步进">
                {[-100, -20, -5, -1, 1, 5, 20, 100].map((delta) => (
                    <button
                        key={delta}
                        type="button"
                        className="size-step-btn"
                        data-testid={'size-step-' + (delta < 0 ? 'minus-' : 'plus-') + Math.abs(delta)}
                        title={(delta > 0 ? '+' : '') + delta + ' px'}
                        onClick={() => adjustWidthPx(delta)}
                    >{delta > 0 ? '+' : ''}{delta}</button>
                ))}
            </div>
            <div className="size-effect-hint">
                留空时按各媒体原始宽度导出；高度按源比例自动计算。
            </div>
        </div>
    ) : (
        <div className="size-editor">
            {/* 输出尺寸控制行：宽×高 + 比例锁 + 模式 + 恢复 */}
            <div className="size-top-row">
            <div className="size-dim-row">
                <label className="size-dim-field">
                    <span className="size-dim-label">宽</span>
                    {sizeMode === 'px' ? (
                        <input
                            className={'input param-number size-dim-input' + (!widthText && source ? ' is-source-value' : '')}
                            ref={widthInputRef}
                            data-testid="width-pixel-input"
                            type="number"
                            min={presets_1.PARAM_LIMITS.widthMin}
                            max={source ?? presets_1.PARAM_LIMITS.widthMax}
                            title={!widthText && source ? '当前为原始宽度 ' + source + ' px，点击可修改' : undefined}
                            placeholder={source ? String(source) : '自动'}
                            value={widthText}
                            onChange={(event) => setWidthText(event.target.value)}
                            onBlur={(event) => commitWidthText(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                    event.preventDefault();
                                    nudgeSize((event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1));
                                    return;
                                }
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    commitWidthText();
                                }
                            }}
                            onWheel={(event) => {
                                event.preventDefault();
                                nudgeSize(event.deltaY < 0 ? 1 : -1);
                            }}
                        />
                    ) : (
                        <input
                            ref={(el) => { widthInputRef.current = el; percentInputRef.current = el; }}
                            className="input param-number size-dim-input"
                            data-testid="width-percent-input"
                            type="number"
                            min={10}
                            max={100}
                            step={1}
                            disabled={!source}
                            value={percentText}
                            onChange={(event) => setPercentText(event.target.value)}
                            onBlur={(event) => commitPercentText(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                    event.preventDefault();
                                    adjustWidthPercent((event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1));
                                    return;
                                }
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    commitPercentText();
                                    percentInputRef.current?.blur();
                                }
                            }}
                            onWheel={(event) => {
                                event.preventDefault();
                                adjustWidthPercent(event.deltaY < 0 ? 1 : -1);
                            }}
                        />
                    )}
                    <span className="param-unit">{sizeMode === 'px' ? 'px' : '%'}</span>
                </label>
                {sizeMode === 'px' ? (
                    <label className="size-dim-field">
                        <span className="size-dim-label">高</span>
                        <input
                            className="input param-number size-dim-input"
                            ref={heightInputRef}
                            data-testid="height-pixel-input"
                            type="number"
                            placeholder={sourceH ? String(sourceH) : '自动'}
                            value={outputHeight ?? ''}
                            readOnly={!aspectRatio}
                            title="输入高度会按源比例反推宽度"
                            onChange={(event) => applyHeightValue(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                    event.preventDefault();
                                    if (outputHeight) {
                                        applyHeightValue(outputHeight + (event.key === 'ArrowUp' ? 2 : -2) * (event.shiftKey ? 5 : 1));
                                    }
                                }
                            }}
                            onWheel={(event) => {
                                if (!outputHeight || !aspectRatio) return;
                                event.preventDefault();
                                applyHeightValue(outputHeight + (event.deltaY < 0 ? 2 : -2));
                            }}
                        />
                        <span className="param-unit">px</span>
                    </label>
                ) : (
                    <label className="size-dim-field">
                        <span className="size-dim-label">高</span>
                        <input
                            className="input param-number size-dim-input"
                            ref={percentHeightInputRef}
                            data-testid="height-percent-input"
                            type="number"
                            min={10}
                            max={100}
                            step={1}
                            disabled={!source}
                            value={percentText}
                            title="与宽度百分比同步，按源比例锁定"
                            onChange={(event) => setPercentText(event.target.value)}
                            onBlur={(event) => commitPercentText(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                    event.preventDefault();
                                    adjustWidthPercent((event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1));
                                    return;
                                }
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    commitPercentText();
                                }
                            }}
                            onWheel={(event) => {
                                event.preventDefault();
                                adjustWidthPercent(event.deltaY < 0 ? 1 : -1);
                            }}
                        />
                        <span className="param-unit">%</span>
                    </label>
                )}
            </div>
            {/* 第二行：像素/百分比 + 恢复原始尺寸 */}
            <div className="size-mode-row">
                <ui_1.Segmented
                    size="sm"
                    value={sizeMode}
                    options={[
                        { value: 'px', label: '像素' },
                        { value: 'percent', label: '百分比' },
                    ]}
                    onChange={(value) => switchSizeMode(value)}
                />
                <button
                    type="button"
                    className="size-reset-btn is-icon"
                    data-testid="size-reset"
                    title="恢复原始尺寸"
                    aria-label="恢复原始尺寸"
                    onClick={() => {
                        setWidthText('');
                        setPercentText('100');
                        update({ width: null });
                    }}
                >
                    <ui_1.Icon name="refresh" size={13} />
                </button>
            </div>
            </div>
            {/* 第三行：8 个平铺步进按钮（绝不弹层） */}
            <div className="size-steps-row" role="group" aria-label="尺寸步进">
                {stepOptions.map((delta) => (
                    <button
                        key={delta}
                        type="button"
                        className="size-step-btn"
                        data-testid={'size-step-' + (delta < 0 ? 'minus-' : 'plus-') + Math.abs(delta)}
                        title={(delta > 0 ? '+' : '') + delta + (sizeMode === 'px' ? ' px' : '%')}
                        onClick={() => applyStep(delta)}
                    >{delta > 0 ? '+' : ''}{delta}</button>
                ))}
            </div>
            {sizeMode === 'percent' ? (
                <div className="size-conversion" data-testid="width-conversion">
                    {source && percentPx !== null
                        ? '= ' + percentPx + ' × ' + outputHeight + ' px'
                        : '当前媒体无源宽高信息'}
                </div>
            ) : null}
            <div className="size-effect-hint">
                {sourceH && source
                    ? '高度输入会按源比例反推宽度；像素范围 ' + presets_1.PARAM_LIMITS.widthMin + '–' + source + ' px。百分比模式宽高均以 % 表示，下方显示实际输出像素。'
                    : '当前媒体无源宽高信息，仅可设置宽度；高度自动。'}
            </div>
        </div>
    )
    if (isBar) {
        return (
            <div className={ui_1.cx('param-panel is-bar', compact && 'is-compact')}>
                <div className="preset-chips">
                    {presets_1.GIF_PRESETS.map((preset) => (
                        <button
                            key={preset.id}
                            type="button"
                            className={ui_1.cx('preset-chip', presetId === preset.id && 'is-active')}
                            onClick={() => applyPreset(preset.id)}
                            title={
                                presetDescription(preset)
                            }
                        >
                            <span className="preset-chip-name">{preset.name}</span>
                            <span className="preset-chip-desc">
                                {presetDescription(preset)}
                            </span>
                        </button>
                    ))}
                    <button
                        type="button"
                        className={ui_1.cx('preset-advanced-toggle', advancedOpen && 'is-open')}
                        onClick={() => setAdvancedOpen((value) => !value)}
                        aria-expanded={advancedOpen}
                        data-testid="advanced-params-toggle"
                    >
                        <ui_1.Icon name={advancedOpen ? 'chevron-down' : 'chevron-right'} size={13} />
                        高级参数
                    </button>
                </div>
                <div className="bar-param-summary" title={summary} data-testid="param-summary">
                    <ui_1.Icon name="layers" size={12} />
                    <span>{summary}</span>
                    {presetId === null ? <span className="param-custom-tag">自定义</span> : null}
                </div>
                {advancedOpen ? (
                    <div className="param-advanced-bar" data-testid="advanced-params">
                        <section className="param-group" data-group="size">
                            <h4 className="param-group-title">输出尺寸</h4>
                            {sizeEditor}
                        </section>
                        <section className="param-group" data-group="encoding">
                            <h4 className="param-group-title">{animFormat === 'webp' ? '帧率' : '编码'}</h4>
                            <div className="param-group-grid is-stacked">
                                {animFormat === 'webp' ? null : encoderRow}
                                {fpsRow}
                                {animFormat === 'webp' ? null : colorsRow}
                                {animFormat === 'webp' ? null : ditherRow}
                                {animFormat === 'webp' ? null : ditherHint}
                                </div>
                        </section>
                        <section className="param-group" data-group="quality">
                            <h4 className="param-group-title">质量</h4>
                            <div className="param-group-grid is-stacked">
                                {qualityRow}
                                {animFormat === 'webp' ? null : optimizeRow}
                                {preserveRow}
                                {animFormat === 'webp' ? null : lossyRow}
                                {animFormat === 'webp' ? null : optimizeWarning}
                            </div>
                        </section>
                        <section className="param-group" data-group="motion">
                            <h4 className="param-group-title">运动与循环</h4>
                            <div className="param-group-grid is-stacked">
                                {speedRow}
                                {loopRow}
                            </div>
                        </section>
                        <section className="param-group" data-group="file">
                            <h4 className="param-group-title">输出文件</h4>
                            {filePreview}
                            {note}
                        </section>
                    </div>
                ) : null}
            </div>
        )
    }
    return (
        <div className={ui_1.cx('param-panel is-full', compact && 'is-compact')}>
            <div className="preset-grid">
                {presets_1.GIF_PRESETS.map((preset) => (
                    <button
                        key={preset.id}
                        type="button"
                        className={ui_1.cx('preset-card', presetId === preset.id && 'is-active')}
                        onClick={() => applyPreset(preset.id)}
                        title={
                            presetDescription(preset)
                        }
                    >
                        <span className="preset-name">{preset.name}</span>
                        <span className="preset-desc">
                            {presetDescription(preset)}
                        </span>
                    </button>
                ))}
            </div>
            {presetId === null ? (
                <div className="param-custom-hint">
                    <ui_1.Icon name="sliders" size={13} />
                    当前为自定义参数（与预设不一致）
                </div>
            ) : null}
            <div className="param-full-groups">
                <section className="param-group is-wide" data-group="size">
                    <h4 className="param-group-title">输出尺寸</h4>
                    {sizeEditor}
                </section>
                <section className="param-group" data-group="encoding">
                    <h4 className="param-group-title">编码</h4>
                    <div className="param-group-grid is-stacked">
                        {encoderRow}
                        {fpsRow}
                        {colorsRow}
                        {ditherRow}
                        {ditherHint}
                    </div>
                </section>
                <section className="param-group" data-group="quality">
                    <h4 className="param-group-title">质量</h4>
                    <div className="param-group-grid is-stacked">
                        {qualityRow}
                        {optimizeRow}
                        {preserveRow}
                        {lossyRow}
                        {optimizeWarning}
                    </div>
                </section>
                <section className="param-group" data-group="motion">
                    <h4 className="param-group-title">运动与循环</h4>
                    <div className="param-group-grid is-stacked">
                        {speedRow}
                        {loopRow}
                    </div>
                </section>
                <section className="param-group is-wide" data-group="file">
                    <h4 className="param-group-title">输出文件</h4>
                    {filePreview}
                    {note}
                </section>
            </div>
        </div>
    )
}

export { ParamPanel };