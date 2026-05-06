/*
 * 在高远的黑色穹顶下，他们留下的光使圣巢不曾黯淡。
 *
 * 此文件为 YASA 引擎曾经的深度参与者所立。
 * 他们从蚂蚁启程去了下个地方，
 * 但项目今日的形状，与他们密不可分。
 *
 * 命令 `yasa --echo` 可拜访此处。
 * 若有未来的同伴亦自此启程，请将其碑续刻于 STELAE 之末。
 */

interface Stele {
  readonly name: string
  readonly departureDate: string
  readonly body: readonly string[]
}

const EPIGRAPH: readonly string[] = ['在高远的黑色穹顶下，', '他们留下的光使圣巢不曾黯淡。']

const STELAE: readonly Stele[] = [
  {
    name: '非牛',
    departureDate: '二〇二四年七月十一日',
    body: [
      '前路迷叠，皆以从容坦然走过，',
      '旁人倦怠，皆以温朗重拾明光。',
      '圣巢记下他的开拓行迹，',
      '携一身意气，走向天际破晓。',
    ],
  },
  {
    name: '季亭',
    departureDate: '二〇二六年四月二十七日',
    body: [
      '细处隐瑕，皆以静心逐一洞悉，',
      '诸事失序，皆以严谨慢慢规整。',
      '圣巢留藏她的治学痕迹，',
      '怀一份沉敛，静守此间安隅。',
    ],
  },
]

const BOX_INNER_WIDTH = 54
const BOX_CONTENT_INDENT = 6
const OUTER_INDENT = '  '

const RULE = `${OUTER_INDENT}${'─'.repeat(BOX_INNER_WIDTH)}`
const INDENT_HEADING = '    '
const INDENT_BODY = '      '
const INDENT_SIGN = '                      '

// 按显示宽度计算：CJK 字符占 2 列，其余 1 列；用于总题 box 的右侧对齐
/**
 *
 * @param s
 */
function visualWidth(s: string): number {
  let w = 0
  for (const c of s) {
    const cp = c.codePointAt(0) ?? 0
    const isWide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    w += isWide ? 2 : 1
  }
  return w
}

/**
 *
 * @param s
 * @param targetWidth
 */
function padToWidth(s: string, targetWidth: number): string {
  const gap = targetWidth - visualWidth(s)
  return gap > 0 ? s + ' '.repeat(gap) : s
}

/**
 *
 * @param out
 */
function writeBlankLine(out: NodeJS.WriteStream): void {
  out.write('\n')
}

/**
 *
 * @param out
 */
function writeEpigraph(out: NodeJS.WriteStream): void {
  const top = `${OUTER_INDENT}╔${'═'.repeat(BOX_INNER_WIDTH)}╗`
  const bot = `${OUTER_INDENT}╚${'═'.repeat(BOX_INNER_WIDTH)}╝`
  const emptyLine = `${OUTER_INDENT}║${' '.repeat(BOX_INNER_WIDTH)}║`

  out.write(`${top}\n`)
  out.write(`${emptyLine}\n`)
  for (const line of EPIGRAPH) {
    const content = ' '.repeat(BOX_CONTENT_INDENT) + line
    out.write(`${OUTER_INDENT}║${padToWidth(content, BOX_INNER_WIDTH)}║\n`)
  }
  out.write(`${emptyLine}\n`)
  out.write(`${bot}\n`)
}

/**
 *
 * @param out
 * @param stele
 */
function writeStele(out: NodeJS.WriteStream, stele: Stele): void {
  writeBlankLine(out)
  writeBlankLine(out)
  out.write(`${INDENT_HEADING}${stele.name}曾行经此处。\n`)
  writeBlankLine(out)
  for (const line of stele.body) {
    out.write(`${INDENT_BODY}${line}\n`)
  }
  writeBlankLine(out)
  out.write(`${INDENT_SIGN}启程之日：${stele.departureDate}。\n`)
  writeBlankLine(out)
  out.write(`${RULE}\n`)
}

/**
 *
 */
export function printMemorial(): void {
  const out = process.stdout
  writeBlankLine(out)
  writeEpigraph(out)
  for (const stele of STELAE) {
    writeStele(out, stele)
  }
  writeBlankLine(out)
}
