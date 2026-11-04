import { memo } from 'react'

import { highlight } from '../../utils/search'

interface HighlightProps {
  text: string
  keyword: string
  className?: string
}

/**
 * 搜索命中高亮（名称 / 地址 / 用户名 / 备注共用）。
 *
 * 底色用 `--primary-30`（30% 品牌色）而不是契约里备选的 `--primary-08`（8%）。
 * 8% 在浅色主题的 --surface 上几乎不可见，等于没做高亮；30% 是已有 token，
 * 亮暗两套都够清楚，且与正文选区 ::selection 同色，视觉语言一致。
 * 只染底不改字色：主机名/正文的颜色必须保持 --text-1，高亮不能变成"给文字上色"。
 */
export const Highlight = memo(function Highlight({
  text,
  keyword,
  className
}: HighlightProps): JSX.Element {
  const segments = highlight(text, keyword)
  if (segments.length === 1 && !segments[0].matched) {
    return <span className={className}>{text}</span>
  }
  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.matched ? (
          <mark key={index} className="rounded-[2px] bg-primary-30 text-inherit">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </span>
  )
})
