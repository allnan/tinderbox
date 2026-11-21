import { Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type OptionRow = { value: string; label: ReactNode; text: string; disabled: boolean; group?: string }
type Position = { left: number; top: number; width: number; maxHeight: number }
type Props = {
  value: string
  onValueChange: (value: string) => void
  children: ReactNode
  className?: string
  disabled?: boolean
  placeholder?: string
  'aria-label'?: string
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children)
  return ''
}

function readOptions(children: ReactNode, group?: string): OptionRow[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; label?: string; disabled?: boolean }>(child)) return []
    if (child.type === Fragment) return readOptions(child.props.children, group)
    if (child.type === 'optgroup') return readOptions(child.props.children, child.props.label ?? group)
    if (child.type !== 'option') return []
    const label = child.props.children ?? child.props.label ?? ''
    return [{ value: String(child.props.value ?? textContent(label)), label, text: textContent(label), disabled: Boolean(child.props.disabled), group }]
  })
}

function nextEnabled(options: OptionRow[], current: number, direction: 1 | -1) {
  if (!options.length) return -1
  let index = current
  for (let count = 0; count < options.length; count += 1) {
    index = (index + direction + options.length) % options.length
    if (!options[index].disabled) return index
  }
  return -1
}

export function DropdownSelect({ value, onValueChange, children, className = '', disabled = false, placeholder = '请选择', 'aria-label': ariaLabel }: Props) {
  const options = readOptions(children)
  const selectedIndex = options.findIndex((option) => option.value === String(value))
  const selected = options[selectedIndex]
  const groupCount = new Set(options.map((option) => option.group).filter(Boolean)).size
  const listId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef(new Map<number, HTMLDivElement>())
  const typeaheadRef = useRef({ value: '', at: 0 })
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [position, setPosition] = useState<Position>({ left: 10, top: 10, width: 220, maxHeight: 280 })

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    const menu = menuRef.current
    const widestOption = menu
      ? Math.max(0, ...Array.from(menu.querySelectorAll<HTMLElement>('.cfm-dropdown-option > span:first-child'), (element) => element.scrollWidth))
      : 0
    const widestGroup = menu
      ? Math.max(0, ...Array.from(menu.querySelectorAll<HTMLElement>('.cfm-dropdown-group-label > span'), (element) => element.scrollWidth))
      : 0
    const menuWidth = Math.max(rect.width, widestOption + 56, widestGroup + 32)
    const width = Math.min(menuWidth, Math.max(120, viewportWidth - 20))
    const estimatedHeight = options.length * 44 + groupCount * 32 + 12
    const menuBorders = menu ? menu.offsetHeight - menu.clientHeight : 0
    const contentHeight = menu ? menu.scrollHeight + menuBorders : estimatedHeight
    const desiredHeight = Math.min(420, contentHeight)
    const margin = 8
    const gap = 5
    const below = Math.max(0, viewportHeight - rect.bottom - gap - margin)
    const above = Math.max(0, rect.top - gap - margin)
    const opensAbove = below < desiredHeight && above > below
    const available = opensAbove ? above : below
    const maxHeight = Math.min(desiredHeight, available)
    const left = Math.min(Math.max(10, rect.left), viewportWidth - width - 10)
    const rawTop = opensAbove ? rect.top - maxHeight - gap : rect.bottom + gap
    const top = Math.min(Math.max(margin, rawTop), viewportHeight - maxHeight - margin)
    setPosition((current) => current.left === left && current.top === top && current.width === width && current.maxHeight === maxHeight
      ? current
      : { left, top, width, maxHeight })
  }, [groupCount, options.length])

  const openMenu = useCallback((direction: 1 | -1 = 1) => {
    if (disabled) return
    const start = selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : direction === 1 ? -1 : 0
    setActiveIndex(selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : nextEnabled(options, start, direction))
    setOpen(true)
  }, [disabled, options, selectedIndex])

  const choose = useCallback((index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onValueChange(option.value)
    setOpen(false)
    triggerRef.current?.focus()
  }, [onValueChange, options])

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      if (!open) openMenu(direction)
      else setActiveIndex((current) => nextEnabled(options, current, direction))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const start = event.key === 'Home' ? -1 : 0
      const direction = event.key === 'Home' ? 1 : -1
      if (!open) setOpen(true)
      setActiveIndex(nextEnabled(options, start, direction))
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) choose(activeIndex)
      else openMenu()
      return
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now()
      const current = now - typeaheadRef.current.at > 800 ? '' : typeaheadRef.current.value
      const query = `${current}${event.key}`.toLocaleLowerCase()
      typeaheadRef.current = { value: query, at: now }
      const start = selectedIndex < 0 ? 0 : selectedIndex + 1
      const ordered = [...options.slice(start), ...options.slice(0, start)]
      const match = ordered.find((option) => !option.disabled && option.text.toLocaleLowerCase().startsWith(query))
      if (match) {
        const index = options.indexOf(match)
        setActiveIndex(index)
        if (!open) setOpen(true)
      }
    }
  }

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    const active = optionRefs.current.get(activeIndex)
    const menu = menuRef.current
    if (active && menu) {
      const menuRect = menu.getBoundingClientRect()
      const activeRect = active.getBoundingClientRect()
      if (activeRect.top < menuRect.top) menu.scrollTop -= menuRect.top - activeRect.top
      else if (activeRect.bottom > menuRect.bottom) menu.scrollTop += activeRect.bottom - menuRect.bottom
    }
  }, [activeIndex, open, updatePosition])

  useEffect(() => {
    if (!open) return
    function closeOutside(event: PointerEvent) {
      const target = event.target as Node | null
      if (target && !triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, updatePosition])

  let lastGroup: string | undefined
  const menu = open ? createPortal(<div id={listId} ref={menuRef} role="listbox" aria-label={ariaLabel} className="cfm-dropdown-menu" style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}>
    {options.map((option, index) => {
      const showGroup = option.group && option.group !== lastGroup
      if (option.group) lastGroup = option.group
      return <Fragment key={`${option.value}-${index}`}>
        {showGroup && <div className="cfm-dropdown-group-label"><span>{option.group}</span></div>}
        <div ref={(element) => { if (element) optionRefs.current.set(index, element); else optionRefs.current.delete(index) }} id={`${listId}-${index}`} role="option" aria-selected={index === selectedIndex} aria-disabled={option.disabled || undefined} className={`cfm-dropdown-option${index === activeIndex ? ' active' : ''}${index === selectedIndex ? ' selected' : ''}${option.disabled ? ' disabled' : ''}`} title={option.text} onPointerEnter={() => { if (!option.disabled) setActiveIndex(index) }} onClick={() => choose(index)}>
          <span>{option.label}</span>{index === selectedIndex && <i aria-hidden="true">✓</i>}
        </div>
      </Fragment>
    })}
  </div>, document.body) : null

  return <>
    <button ref={triggerRef} type="button" role="combobox" className={`cfm-dropdown-trigger ${className}`.trim()} disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined} title={selected?.text ?? String(value)} onClick={() => open ? setOpen(false) : openMenu()} onKeyDown={onKeyDown}>
      <span className="cfm-dropdown-value">{selected?.label ?? (String(value) || placeholder)}</span><span className="cfm-dropdown-chevron" aria-hidden="true" />
    </button>
    {menu}
  </>
}
