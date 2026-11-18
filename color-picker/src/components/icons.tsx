/** 取色器内部使用的三个图标（吸管 / 恢复 / 图钉），SVG 路径与配色工坊一致。 */
import type { CSSProperties, ReactNode } from 'react'

export type PickerIconName = 'pipette' | 'refresh' | 'pin'

const PATHS: Record<PickerIconName, ReactNode> = {
  pipette: <path d="M4 20l2.5-.5L19 7a2.8 2.8 0 0 0-4-4L2.5 15.5zM14 5l5 5" />,
  refresh: <path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6" />,
  pin: <path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z" />,
}

export interface PickerIconProps {
  name: PickerIconName
  size?: number
  strokeWidth?: number
  className?: string
  style?: CSSProperties
}

export function PickerIcon({ name, size = 14, strokeWidth = 1.8, className, style }: PickerIconProps) {
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
