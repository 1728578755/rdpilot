import { cn } from '../../utils/cn'

interface BrandMarkProps {
  /** 边长（px）：顶栏 20、侧边栏 32 */
  size?: number
  className?: string
}

/**
 * 品牌标识：渐变圆角方块 + 白色 R。
 *
 * 顶栏与侧边栏共用同一份实现——旧版两处各写一遍（侧边栏 32px 用 token 渐变，
 * 顶栏根本没有），字号/圆角会随着改动漂移。渐变写死内联：它不属于主题变量，
 * 亮暗两套主题下必须完全一致，走 var(--gradient-brand) 反而多一层间接。
 */
export function BrandMark({ size = 20, className }: BrandMarkProps): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: 'linear-gradient(135deg, #5b7cfa 0%, #7c5cf7 100%)',
        fontSize: Math.round(size * 0.55)
      }}
      className={cn(
        'flex flex-none select-none items-center justify-center font-bold leading-none text-white',
        className
      )}
    >
      R
    </span>
  )
}
