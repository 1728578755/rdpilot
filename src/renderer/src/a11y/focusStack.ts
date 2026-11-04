/**
 * 焦点陷阱栈（Batch 2 · Agent H）。
 *
 * 与 utils/overlayStack 同构，但职责不同：
 *  - overlayStack 回答「Esc 该关哪一层」；
 *  - 本栈回答「Tab 该由哪一层接管」以及「关闭后焦点还给谁」。
 *
 * 两层浮层叠放时，Modal/Drawer 各自的 document 级 keydown 监听仍然存在，
 * 只有栈顶那层可以循环 Tab；下层只保留自己的容器和还焦目标。
 *
 * 这里刻意不碰 DOM：纯函数便于 scripts/verify-a11y.mjs 直接做单元测试。
 */
export interface FocusTrapStack {
  /** 进栈：同 id 已在栈中时先移除再压顶，保证一个 id 只占一层 */
  push: (id: string) => void
  /** 出栈：id 不在栈中时静默忽略，容忍乱序卸载 */
  pop: (id: string) => void
  /** 自己是否栈顶 */
  isTop: (id: string) => boolean
  /** 当前栈顶 id；空栈为 null */
  top: () => string | null
  /** 当前层数 */
  size: () => number
  /** 只读快照（调试/测试用） */
  ids: () => readonly string[]
}

export function createFocusTrapStack(): FocusTrapStack {
  const stack: string[] = []
  return {
    push(id) {
      const index = stack.indexOf(id)
      if (index !== -1) stack.splice(index, 1)
      stack.push(id)
    },
    pop(id) {
      const index = stack.lastIndexOf(id)
      if (index !== -1) stack.splice(index, 1)
    },
    isTop(id) {
      return stack[stack.length - 1] === id
    },
    top() {
      return stack.length > 0 ? stack[stack.length - 1] : null
    },
    size() {
      return stack.length
    },
    ids() {
      return [...stack]
    }
  }
}

/** 全局共享栈：所有 useFocusTrap 实例共用一份顺序 */
export const focusTrapStack = createFocusTrapStack()
