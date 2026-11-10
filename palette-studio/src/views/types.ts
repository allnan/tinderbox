import type { Project } from '../shared/types'

/** 项目工作台内各视图的统一 props */
export interface ProjectViewProps {
  project: Project
  /** 当前预览的明暗模式 */
  mode: 'light' | 'dark'
}
