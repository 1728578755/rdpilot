/**
 * 浮层焦点陷阱（Modal / Drawer 共用）。
 *
 * 实现已迁到 `utils/focusTrap.ts`（Batch 2 · Agent H）：
 *  - 真正的栈式嵌套：叠放时只有栈顶浮层接管 Tab，一次 Esc 只关最上层；
 *  - 初始焦点优先 `[data-autofocus]`，否则第一个可操作元素，最后回落容器自身；
 *  - 关闭后只在焦点仍属于本层（或已落回 body / 随卸载丢失）时还给 opener，
 *    不抢走紧接着打开的另一层浮层的初始焦点。
 *
 * 本文件仅保留兼容导出：Modal/Drawer 仍按 `./focusTrap` 引用，API 不变。
 */
export { focusTrapStack, useFocusTrap, type FocusTrapStack } from '../../utils/focusTrap'
