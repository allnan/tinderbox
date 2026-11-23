import * as vscode from "vscode";

/** 当前 VS Code 显示语言是否为中文。运行时读取，切换显示语言后重载即可生效。 */
export function isChinese(): boolean {
  return vscode.env.language.toLowerCase().startsWith("zh");
}

/** 按当前显示语言返回中文或英文文案。 */
export function tr(zh: string, en: string): string {
  return isChinese() ? zh : en;
}
