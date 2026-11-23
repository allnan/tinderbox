import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { PolicyConfig } from './core/bridge'

type OrderSide = 'display' | 'traffic'

function defaultRuleGroupOrder(policy: PolicyConfig) {
  const groupsByName = new Map(policy.groups.map((group) => [group.name, group]))
  const firstRuleOrder: string[] = []
  policy.rules.forEach((rule) => {
    const group = groupsByName.get(rule.target)
    if (group && rule.kind.trim().toUpperCase() !== 'MATCH' && !firstRuleOrder.includes(group.id)) firstRuleOrder.push(group.id)
  })
  const validIds = new Set(policy.groups.map((group) => group.id))
  const configured = policy.ruleGroupOrder ?? []
  const result = configured.length
    ? configured.filter((id, index) => validIds.has(id) && configured.indexOf(id) === index)
    : firstRuleOrder
  for (const id of (configured.length ? policy.groups.map((group) => group.id) : firstRuleOrder)) {
    if (validIds.has(id) && !result.includes(id)) result.push(id)
  }
  const unreferencedGroups = policy.groups.filter((group) => !result.includes(group.id))
  if (configured.length) result.push(...unreferencedGroups.map((group) => group.id))
  else result.push(...unreferencedGroups.sort((a, b) => a.id.localeCompare(b.id)).map((group) => group.id))
  return result
}

function moveItem(items: string[], from: number, to: number) {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

export function PolicyRuleGroupOrderDialog(props: {
  policy: PolicyConfig | null
  policyName: string
  busy: boolean
  onClose: () => void
  onApply: (displayOrder: string[], trafficOrder: string[] | null) => void
}) {
  const initialDisplayOrder = useMemo(() => props.policy?.groups.map((group) => group.id) ?? [], [props.policy])
  const initialTrafficOrder = useMemo(() => props.policy ? defaultRuleGroupOrder(props.policy) : [], [props.policy])
  const [displayOrder, setDisplayOrder] = useState(initialDisplayOrder)
  const [trafficOrder, setTrafficOrder] = useState(initialTrafficOrder)
  const [columnCount, setColumnCount] = useState(3)
  const [hoveredGroupId, setHoveredGroupId] = useState('')
  const [draggingId, setDraggingId] = useState('')
  const [draggingSide, setDraggingSide] = useState<OrderSide | ''>('')
  const [dragPreviewSize, setDragPreviewSize] = useState<{ width: number; height: number } | null>(null)
  const displayOrderRef = useRef(displayOrder)
  const trafficOrderRef = useRef(trafficOrder)
  const listRef = useRef<HTMLDivElement>(null)
  const accessListRef = useRef<HTMLDivElement>(null)
  const hoveredGroupRef = useRef('')
  const counterpartScrollFrameRef = useRef<number | null>(null)
  const dragRef = useRef<{ pointerId: number; groupId: string; side: OrderSide; pointerX: number; pointerY: number; offsetX: number; offsetY: number } | null>(null)
  const dragAutoScrollFrameRef = useRef<number | null>(null)
  const dragListenersRef = useRef<{ move: (event: PointerEvent) => void; end: (event: PointerEvent) => void } | null>(null)
  const dragPreviewRef = useRef<HTMLDivElement>(null)
  const groupsById = useMemo(() => new Map((props.policy?.groups ?? []).map((group) => [group.id, group])), [props.policy])
  const displayOrderHasChanges = displayOrder.length !== initialDisplayOrder.length || displayOrder.some((id, index) => id !== initialDisplayOrder[index])
  const trafficOrderHasChanges = trafficOrder.length !== initialTrafficOrder.length || trafficOrder.some((id, index) => id !== initialTrafficOrder[index])
  const hasChanges = displayOrderHasChanges || trafficOrderHasChanges
  const accessOrder = useMemo(() => trafficOrder.filter((id) => groupsById.has(id)), [groupsById, trafficOrder])
  const displayRows = Math.max(1, Math.ceil(displayOrder.length / columnCount))
  const trafficRows = Math.max(1, Math.ceil(accessOrder.length / columnCount))

  useLayoutEffect(() => {
    const lists = [listRef.current, accessListRef.current].filter((list): list is HTMLDivElement => Boolean(list))
    const updateColumnCount = () => {
      const list = lists.find((item) => item.isConnected)
      if (!list) return
      const count = Number.parseInt(getComputedStyle(list).getPropertyValue('--policy-order-columns'), 10)
      if (Number.isFinite(count) && count > 0) setColumnCount(count)
    }
    updateColumnCount()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateColumnCount)
    lists.forEach((list) => observer?.observe(list))
    window.addEventListener('resize', updateColumnCount)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateColumnCount)
    }
  }, [props.policy])

  useEffect(() => {
    if (!props.policy) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !props.busy) props.onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [props.busy, props.onClose, props.policy])

  function getOrder(side: OrderSide) {
    return side === 'display' ? displayOrderRef.current : trafficOrderRef.current
  }

  function getList(side: OrderSide) {
    return side === 'display' ? listRef.current : accessListRef.current
  }

  function animateOrder(side: OrderSide, nextOrder: string[]) {
    const current = getOrder(side)
    if (nextOrder.every((id, index) => id === current[index])) return
    const list = getList(side)
    const before = new Map<string, DOMRect>()
    list?.querySelectorAll<HTMLElement>('[data-policy-rule-group-id]').forEach((card) => {
      const id = card.dataset.policyRuleGroupId
      if (id) before.set(id, card.getBoundingClientRect())
    })
    flushSync(() => {
      if (side === 'display') {
        displayOrderRef.current = nextOrder
        setDisplayOrder(nextOrder)
      } else {
        trafficOrderRef.current = nextOrder
        setTrafficOrder(nextOrder)
      }
    })
    for (const card of list?.querySelectorAll<HTMLElement>('[data-policy-rule-group-id]') ?? []) {
      const id = card.dataset.policyRuleGroupId
      const previous = id ? before.get(id) : undefined
      if (!previous) continue
      const next = card.getBoundingClientRect()
      const x = previous.left - next.left
      const y = previous.top - next.top
      if (Math.abs(x) < 1 && Math.abs(y) < 1) continue
      card.style.transition = 'none'
      card.style.transform = `translate(${x}px, ${y}px)`
    }
    list?.getBoundingClientRect()
    window.requestAnimationFrame(() => {
      for (const card of list?.querySelectorAll<HTMLElement>('[data-policy-rule-group-id]') ?? []) {
        card.style.transition = ''
        card.style.transform = ''
      }
    })
  }

  function moveDraggedGroupAtPointer(drag: NonNullable<typeof dragRef.current>) {
    const list = getList(drag.side)
    if (!list) return
    const listRect = list.getBoundingClientRect()
    if (drag.pointerX < listRect.left || drag.pointerX > listRect.right) return
    const order = getOrder(drag.side)
    if (order.length < 2) return
    const remainingIds = order.filter((id) => id !== drag.groupId)
    const cardsById = new Map([...list.querySelectorAll<HTMLElement>('[data-policy-rule-group-id]')]
      .map((card) => [card.dataset.policyRuleGroupId, card] as const))
    const columns: { left: number; centerX: number; entries: { id: string; centerY: number; orderIndex: number }[] }[] = []
    for (const [orderIndex, id] of remainingIds.entries()) {
      const card = cardsById.get(id)
      if (!card) continue
      const rect = card.getBoundingClientRect()
      let column = columns.find((candidate) => Math.abs(candidate.left - rect.left) < 3)
      if (!column) {
        column = { left: rect.left, centerX: rect.left + rect.width / 2, entries: [] }
        columns.push(column)
      }
      column.entries.push({ id, centerY: rect.top + rect.height / 2, orderIndex })
    }
    if (!columns.length) return

    const pointerX = Math.max(listRect.left, Math.min(listRect.right, drag.pointerX))
    const column = columns.reduce((nearest, candidate) => Math.abs(candidate.centerX - pointerX) < Math.abs(nearest.centerX - pointerX) ? candidate : nearest)
    const pointerY = Math.max(listRect.top, Math.min(listRect.bottom, drag.pointerY))
    const before = column.entries.find((entry) => pointerY < entry.centerY)
    const last = column.entries[column.entries.length - 1]
    const destination = before?.orderIndex ?? (last?.orderIndex ?? remainingIds.length - 1) + 1
    const next = [...remainingIds]
    next.splice(Math.max(0, Math.min(remainingIds.length, destination)), 0, drag.groupId)
    animateOrder(drag.side, next)
  }

  function getAutoScrollDelta(drag: NonNullable<typeof dragRef.current>, list: HTMLDivElement) {
    const rect = list.getBoundingClientRect()
    if (drag.pointerX < rect.left || drag.pointerX > rect.right) return 0
    const edgeSize = Math.min(52, Math.max(32, rect.height * 0.12))
    const outsideAllowance = 36
    const fromTop = drag.pointerY - rect.top
    const fromBottom = rect.bottom - drag.pointerY
    if (fromTop < edgeSize && fromTop >= -outsideAllowance) return -Math.ceil(3 + Math.min(edgeSize + outsideAllowance, edgeSize - fromTop) * 0.35)
    if (fromBottom < edgeSize && fromBottom >= -outsideAllowance) return Math.ceil(3 + Math.min(edgeSize + outsideAllowance, edgeSize - fromBottom) * 0.35)
    return 0
  }

  function runAutoScrollFrame() {
    dragAutoScrollFrameRef.current = null
    const drag = dragRef.current
    const list = drag ? getList(drag.side) : null
    if (!drag || !list) return
    const delta = getAutoScrollDelta(drag, list)
    if (!delta) return
    const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight)
    const nextScroll = Math.max(0, Math.min(maxScroll, list.scrollTop + delta))
    if (nextScroll === list.scrollTop) return
    list.scrollTop = nextScroll
    moveDraggedGroupAtPointer(drag)
    dragAutoScrollFrameRef.current = window.requestAnimationFrame(runAutoScrollFrame)
  }

  function placeDraggedGroup(event: PointerEvent) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    drag.pointerX = event.clientX
    drag.pointerY = event.clientY
    if (dragPreviewRef.current) dragPreviewRef.current.style.transform = `translate3d(${drag.pointerX - drag.offsetX}px, ${drag.pointerY - drag.offsetY}px, 0)`
    moveDraggedGroupAtPointer(drag)
    if (dragAutoScrollFrameRef.current === null) dragAutoScrollFrameRef.current = window.requestAnimationFrame(runAutoScrollFrame)
  }

  function removeDragListeners() {
    const listeners = dragListenersRef.current
    if (!listeners) return
    window.removeEventListener('pointermove', listeners.move)
    window.removeEventListener('pointerup', listeners.end)
    window.removeEventListener('pointercancel', listeners.end)
    dragListenersRef.current = null
  }

  function finishDrag(pointerId: number) {
    if (dragRef.current?.pointerId !== pointerId) return
    dragRef.current = null
    if (dragAutoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(dragAutoScrollFrameRef.current)
      dragAutoScrollFrameRef.current = null
    }
    removeDragListeners()
    setDraggingId('')
    setDraggingSide('')
    setDragPreviewSize(null)
  }

  function beginDrag(event: ReactPointerEvent<HTMLElement>, groupId: string, side: OrderSide) {
    if (event.button !== 0 || props.busy || dragRef.current) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      groupId,
      side,
      pointerX: event.clientX,
      pointerY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
    setDragPreviewSize({ width: rect.width, height: rect.height })
    setDraggingId(groupId)
    setDraggingSide(side)
    const move = (pointerEvent: PointerEvent) => placeDraggedGroup(pointerEvent)
    const end = (pointerEvent: PointerEvent) => finishDrag(pointerEvent.pointerId)
    dragListenersRef.current = { move, end }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    try {
      event.currentTarget.ownerDocument.body.setPointerCapture(event.pointerId)
    } catch {
      // Window-level listeners continue to handle the drag if capture is unavailable.
    }
  }

  useLayoutEffect(() => {
    const drag = dragRef.current
    const preview = dragPreviewRef.current
    if (!draggingId || !drag || drag.groupId !== draggingId || drag.side !== draggingSide || !preview) return
    preview.style.transform = `translate3d(${drag.pointerX - drag.offsetX}px, ${drag.pointerY - drag.offsetY}px, 0)`
  }, [draggingId, draggingSide, dragPreviewSize])

  useEffect(() => () => {
    removeDragListeners()
    if (dragAutoScrollFrameRef.current !== null) window.cancelAnimationFrame(dragAutoScrollFrameRef.current)
    if (counterpartScrollFrameRef.current !== null) window.cancelAnimationFrame(counterpartScrollFrameRef.current)
  }, [])

  function setHoveredGroup(id: string, sourceSide?: OrderSide) {
    if (hoveredGroupRef.current === id) return
    hoveredGroupRef.current = id
    setHoveredGroupId(id)
    if (counterpartScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(counterpartScrollFrameRef.current)
      counterpartScrollFrameRef.current = null
    }
    if (!id || !sourceSide) return
    counterpartScrollFrameRef.current = window.requestAnimationFrame(() => {
      counterpartScrollFrameRef.current = null
      const list = getList(sourceSide === 'display' ? 'traffic' : 'display')
      const counterpart = [...(list?.querySelectorAll<HTMLElement>('[data-policy-rule-group-id]') ?? [])]
        .find((card) => card.dataset.policyRuleGroupId === id)
      if (!list || !counterpart) return
      const listRect = list.getBoundingClientRect()
      const cardRect = counterpart.getBoundingClientRect()
      if (cardRect.top < listRect.top || cardRect.bottom > listRect.bottom) {
        counterpart.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
      }
    })
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const card = (event.target as Element).closest<HTMLElement>('[data-policy-rule-group-id]')
    if (!card || !event.currentTarget.contains(card)) {
      setHoveredGroup('', undefined)
      return
    }
    const rect = card.getBoundingClientRect()
    const inset = Math.min(2, rect.height / 5)
    const inside = event.clientX > rect.left + inset && event.clientX < rect.right - inset
      && event.clientY > rect.top + inset && event.clientY < rect.bottom - inset
    const side = card.dataset.orderSide === 'display' || card.dataset.orderSide === 'traffic' ? card.dataset.orderSide : undefined
    setHoveredGroup(inside ? card.dataset.policyRuleGroupId ?? '' : '', side)
  }

  function handlePointerLeave() {
    setHoveredGroup('', undefined)
  }

  function handleCardKeyDown(event: ReactKeyboardEvent<HTMLElement>, side: OrderSide, id: string) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const order = getOrder(side)
    const from = order.indexOf(id)
    const to = Math.max(0, Math.min(order.length - 1, from + (event.key === 'ArrowUp' ? -1 : 1)))
    animateOrder(side, moveItem(order, from, to))
  }

  function applyOrder() {
    if (!hasChanges || props.busy) return
    const nextTrafficOrder = trafficOrderHasChanges
      ? trafficOrder
      : props.policy?.ruleGroupOrder?.length ? initialTrafficOrder : null
    props.onApply(displayOrder, nextTrafficOrder)
    props.onClose()
  }

  if (!props.policy) return null
  const draggingGroup = groupsById.get(draggingId)
  const dialog = <div className="policy-rule-order-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget && !props.busy) props.onClose() }}>
    <section className="policy-rule-order-dialog" role="dialog" aria-modal="true" aria-labelledby="policy-rule-order-title">
      <header className="policy-rule-order-header">
        <div><span className="eyebrow">STRATEGY GROUP ORDER</span><h2 id="policy-rule-order-title">「{props.policyName}」策略组顺序</h2><p>左右两边分别排序；每列从上到下查看。</p></div>
        <button className="button secondary small" type="button" disabled={props.busy} onClick={props.onClose}>关闭</button>
      </header>
      <div className="policy-rule-order-body">
        <div className="policy-rule-order-note"><strong>左边调整方案里的策略组显示顺序；右边调整流量检查策略组规则的顺序。</strong><span>每边按列从上到下排列；两边拖动互不影响。悬停组名会同时高亮另一侧同名组。全部规则都未命中时，仍按黄色“未命中规则时”的 MATCH 去向处理。</span></div>
        <div className="policy-rule-order-columns" onPointerMove={handlePointerMove} onPointerLeave={handlePointerLeave}>
          <section className="policy-rule-order-panel policy-rule-order-groups" aria-label="策略组展示顺序">
            <header className="policy-rule-order-panel-header"><div><strong>策略组展示顺序</strong><small>只调整方案中的组排列</small></div><b>{displayOrder.length} 组</b></header>
            {displayOrder.length ? <div className="policy-rule-order-list" ref={listRef} role="list" aria-label="策略组展示顺序" style={{ gridTemplateRows: `repeat(${displayRows}, 38px)` }}>
              {displayOrder.map((id) => {
                const group = groupsById.get(id)
                if (!group) return null
                return <article key={id} data-policy-rule-group-id={id} data-order-side="display" className={'policy-rule-order-row' + (draggingId === id && draggingSide === 'display' ? ' is-dragging' : '') + (hoveredGroupId === id ? ' is-hovered' : '')} onPointerDown={(event) => beginDrag(event, id, 'display')} onKeyDown={(event) => handleCardKeyDown(event, 'display', id)} role="listitem" tabIndex={0} aria-label={`${group.name}，方案展示顺序；使用上下方向键调整`}>
                  <span className="policy-rule-order-grip" aria-hidden="true">⠿</span><strong>{group.name}</strong>
                </article>
              })}
            </div> : <div className="policy-rule-order-empty">当前方案还没有策略组。</div>}
          </section>
          <section className="policy-rule-order-panel policy-rule-order-access" aria-label="流量实际进入策略组的顺序">
            <header className="policy-rule-order-panel-header"><div><strong>流量实际进入顺序</strong><small>按当前生成规则排列</small></div><b>{accessOrder.length} 组</b></header>
            {accessOrder.length ? <div className="policy-rule-order-access-list" ref={accessListRef} role="list" aria-label="流量实际进入策略组的顺序" style={{ gridTemplateRows: `repeat(${trafficRows}, 38px)` }}>
              {accessOrder.map((id) => {
                const group = groupsById.get(id)
                if (!group) return null
                return <article key={id} data-policy-rule-group-id={id} data-order-side="traffic" className={'policy-rule-order-row' + (draggingId === id && draggingSide === 'traffic' ? ' is-dragging' : '') + (hoveredGroupId === id ? ' is-hovered' : '')} onPointerDown={(event) => beginDrag(event, id, 'traffic')} onKeyDown={(event) => handleCardKeyDown(event, 'traffic', id)} role="listitem" tabIndex={0} aria-label={`${group.name}，流量规则检查顺序；使用上下方向键调整`}>
                  <span className="policy-rule-order-grip" aria-hidden="true">⠿</span><strong>{group.name}</strong>
                </article>
              })}
            </div> : <div className="policy-rule-order-empty">当前方案还没有策略组。</div>}
          </section>
        </div>
      </div>
      <footer className="policy-rule-order-footer"><span>左右顺序分别应用到方案草稿；仍需点击右上角“保存方案”提交。</span><div><button className="button secondary" type="button" disabled={props.busy} onClick={props.onClose}>取消</button><button className="button primary" type="button" disabled={props.busy || !hasChanges || displayOrder.length < 2} onClick={applyOrder}>应用顺序</button></div></footer>
    </section>
  </div>
  const dragPreview = draggingGroup && dragPreviewSize ? <div ref={dragPreviewRef} className="policy-rule-order-drag-preview" aria-hidden="true"><article className="policy-rule-order-row policy-rule-order-preview" style={dragPreviewSize}><span className="policy-rule-order-grip">⠿</span><strong>{draggingGroup.name}</strong></article></div> : null
  return createPortal(<>{dialog}{dragPreview}</>, document.body)
}
