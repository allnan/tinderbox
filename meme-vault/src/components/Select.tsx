import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { classNames } from "../lib/format";
import { Icon, type IconName } from "./ui";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  /** 当前值；与某个选项的 value 相等时显示该选项标签，否则显示 placeholder。 */
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** 触发按钮的无障碍名称，同时供读屏与测试定位使用。 */
  ariaLabel: string;
  placeholder?: string;
  icon?: IconName;
  iconSize?: number;
  /** 追加到触发按钮上的类名，用于复用各处的输入框/工具条外观。 */
  className?: string;
  disabled?: boolean;
  title?: string;
  emptyLabel?: string;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/**
 * 自绘下拉选择器：触发按钮 + 挂到 body 的浮层菜单。
 *
 * 原生 <select> 的展开面板由系统绘制，无法跟随应用亮暗主题，且在深色界面里常出现
 * 白底浅字、被滚动容器裁切等问题。这里统一用 CSS 变量绘制，支持键盘操作（方向键、
 * Home/End、Enter/空格、Esc、首字母跳转）与点击外部关闭。
 */
export function Select(props: SelectProps) {
  const {
    value,
    options,
    onChange,
    ariaLabel,
    placeholder = "请选择",
    icon,
    iconSize = 15,
    className,
    disabled,
    title,
    emptyLabel = "暂无可选项",
  } = props;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef({ text: "", at: 0 });
  const baseId = useId();
  const menuId = baseId + "-menu";
  const optionId = (index: number) => baseId + "-option-" + index;

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const closeMenu = useCallback((focusTrigger = false) => {
    setOpen(false);
    setPosition(null);
    setActiveIndex(-1);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  const firstEnabled = (from: number, direction: 1 | -1): number => {
    if (!options.length) return -1;
    let index = from;
    for (let step = 0; step < options.length; step += 1) {
      index = (index + direction + options.length) % options.length;
      if (!options[index]?.disabled) return index;
    }
    return -1;
  };

  const openMenu = (direction: 1 | -1 = 1) => {
    if (disabled) return;
    const start =
      selectedIndex >= 0 && !options[selectedIndex]?.disabled
        ? selectedIndex
        : firstEnabled(direction === 1 ? -1 : 0, direction);
    setActiveIndex(start);
    setPosition(null);
    setOpen(true);
  };

  const moveActive = (direction: 1 | -1) => {
    setActiveIndex((current) =>
      current < 0 ? firstEnabled(direction === 1 ? -1 : 0, direction) : firstEnabled(current, direction),
    );
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    closeMenu(true);
  };

  const jumpTo = (query: string) => {
    if (!query) return;
    const index = options.findIndex(
      (option) => !option.disabled && option.label.toLowerCase().startsWith(query),
    );
    if (index < 0) return;
    if (!open) {
      setActiveIndex(index);
      setPosition(null);
      setOpen(true);
    } else {
      setActiveIndex(index);
    }
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) openMenu(key === "ArrowDown" ? 1 : -1);
      else moveActive(key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (key === "Home" || key === "End") {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex(key === "Home" ? firstEnabled(-1, 1) : firstEnabled(0, -1));
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) openMenu(1);
      else if (activeIndex >= 0) choose(activeIndex);
      return;
    }
    if (key === "Escape") {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (key === "Tab") {
      if (open) closeMenu(false);
      return;
    }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.stopPropagation();
      const now = Date.now();
      if (now - typeaheadRef.current.at > 800) typeaheadRef.current.text = "";
      typeaheadRef.current.text += key.toLowerCase();
      typeaheadRef.current.at = now;
      jumpTo(typeaheadRef.current.text);
    }
  };

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const gutter = 10;
    const gap = 6;
    const availableWidth = Math.max(120, viewportWidth - gutter * 2);
    const width = Math.min(Math.max(rect.width, menu.scrollWidth + 2, 150), availableWidth);
    const naturalHeight = menu.scrollHeight;
    const spaceBelow = viewportHeight - rect.bottom - gap - gutter;
    const spaceAbove = rect.top - gap - gutter;
    const placeAbove = naturalHeight > spaceBelow && spaceAbove > spaceBelow;
    const maxHeight = Math.min(360, Math.max(96, placeAbove ? spaceAbove : spaceBelow));
    const height = Math.min(naturalHeight || maxHeight, maxHeight);
    const top = placeAbove
      ? Math.max(gutter, rect.top - gap - height)
      : Math.min(rect.bottom + gap, viewportHeight - gutter - 96);
    const left = Math.min(Math.max(gutter, rect.left), Math.max(gutter, viewportWidth - width - gutter));
    setPosition((current) =>
      current &&
      Math.abs(current.top - top) < 0.5 &&
      Math.abs(current.left - left) < 0.5 &&
      Math.abs(current.width - width) < 0.5 &&
      Math.abs(current.maxHeight - maxHeight) < 0.5
        ? current
        : { top, left, width, maxHeight },
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
    window.addEventListener("resize", positionMenu);
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      positionMenu();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, options.length, positionMenu]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = menuRef.current?.querySelector('[data-active="true"]');
    if (node instanceof HTMLElement) node.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeMenu(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    };
    const onWindowBlur = () => closeMenu(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [open, closeMenu]);

  const menuStyle: CSSProperties = position
    ? {
        top: position.top,
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        visibility: "visible",
      }
    : { top: 0, left: 0, visibility: "hidden" };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        className={classNames("select-trigger", className)}
        title={title}
        disabled={disabled}
        onClick={() => (open ? closeMenu(true) : openMenu(1))}
        onKeyDown={onTriggerKeyDown}
      >
        {icon && <Icon name={icon} size={iconSize} className="select-icon" />}
        <span className={classNames("select-value", !selected && "select-placeholder")}>
          {selected ? selected.label : placeholder}
        </span>
        <Icon name="chevron-down" size={14} className="select-caret" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="listbox"
            aria-label={ariaLabel}
            className="select-menu"
            style={menuStyle}
          >
            {options.length === 0 && <div className="select-empty">{emptyLabel}</div>}
            {options.map((option, index) => (
              <div
                key={option.value}
                id={optionId(index)}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                data-active={index === activeIndex || undefined}
                className="select-option"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => {
                  if (!option.disabled) setActiveIndex(index);
                }}
                onClick={() => choose(index)}
              >
                <span className="select-option-label">{option.label}</span>
                {option.value === value && <Icon name="check" size={14} className="select-option-check" />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
