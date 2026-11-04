/**
 * 浮层有序栈：Modal / Drawer / ContextMenu 在 mount 时进栈、unmount 时出栈。
 *
 * 为什么需要它：此前三种浮层各自独立监听 window 的 Esc，叠放时（如抽屉上叠确认框）
 * 按一次 Esc 会全部同关，未保存的表单内容直接丢失。现在只有栈顶响应 Esc，
 * 一次 Esc 只关最上层。
 *
 * 之所以不用 context / portal 调度：需求只有"谁在最上面"一个，模块级数组即可，
 * 与各组件现有的 window keydown 监听方式也能最小改动地衔接。
 */

const stack: string[] = []

/** 进栈：同一 id 已在栈中时先移除再压顶，保证一个 id 只占一层 */
export function overlayPush(id: string): void {
  const index = stack.indexOf(id)
  if (index !== -1) stack.splice(index, 1)
  stack.push(id)
}

/** 出栈：id 不在栈中时静默忽略，容忍乱序卸载 */
export function overlayPop(id: string): void {
  const index = stack.lastIndexOf(id)
  if (index !== -1) stack.splice(index, 1)
}

/** 自己是否栈顶（各浮层的 Esc 处理以此为开关） */
export function overlayIsTop(id: string): boolean {
  return stack[stack.length - 1] === id
}

/** 是否有任何浮层在栈中（全局快捷键据此决定是否让路，避免在确认框背后"隐身"开表单） */
export function overlayIsActive(): boolean {
  return stack.length > 0
}
