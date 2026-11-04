/**
 * 导入文件的编码探测。
 *
 * 现实里的输入：
 *  - mstsc 自己导出的 `.rdp` 是 UTF-16LE + BOM；
 *  - 中文 Excel 另存的 CSV 常见 GBK/GB18030；
 *  - 手工编辑/第三方工具多为 UTF-8（有时带 BOM）。
 *
 * Node 22 自带 full-icu，`TextDecoder('gbk')` 可用；不可用时回落到 UTF-8（不抛错，
 * 坏字符变 U+FFFD 也比整个导入失败好）。
 */

/** 去掉 BOM 与尾部 NUL；返回纯文本 */
function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\u0000+$/g, '')
}

/** UTF-16BE → UTF-16LE（Node 没有内置 utf16be 解码器） */
function swapBytes(buffer: Buffer): Buffer {
  const copy = Buffer.from(buffer)
  for (let i = 0; i + 1 < copy.length; i += 2) {
    const first = copy[i]
    copy[i] = copy[i + 1]
    copy[i + 1] = first
  }
  return copy
}

/** 无 BOM 时判断是否是 UTF-16LE：ASCII 文本的奇数位大量为 0x00 */
function looksLikeUtf16Le(buffer: Buffer): boolean {
  if (buffer.length < 4) return false
  const sample = Math.min(buffer.length, 512)
  let evenNul = 0
  let oddNul = 0
  for (let i = 0; i < sample; i += 1) {
    if (buffer[i] !== 0) continue
    if (i % 2 === 0) evenNul += 1
    else oddNul += 1
  }
  // 奇数位为 0 才是 LE（'A' = 41 00）
  return oddNul > sample / 8 && evenNul < oddNul / 4
}

export function decodeTextBuffer(buffer: Buffer): string {
  if (buffer.length === 0) return ''

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return stripBom(buffer.subarray(2).toString('utf16le'))
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return stripBom(swapBytes(buffer.subarray(2)).toString('utf16le'))
  }
  if (looksLikeUtf16Le(buffer)) {
    return stripBom(buffer.toString('utf16le'))
  }

  // UTF-8 BOM 或无 BOM 的 UTF-8：用 fatal 模式严格校验，抛错才说明不是 UTF-8
  const offset = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0
  const body = buffer.subarray(offset)
  try {
    return stripBom(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    // 中文 Windows 的 Excel 导出物：GBK/GB18030
    try {
      return stripBom(new TextDecoder('gbk', { fatal: false }).decode(body))
    } catch {
      return stripBom(body.toString('utf8'))
    }
  }
}
