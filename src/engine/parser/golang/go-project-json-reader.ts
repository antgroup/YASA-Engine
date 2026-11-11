import * as fs from 'fs'
import { StringDecoder } from 'string_decoder'

type JsonPath = Array<string | number>
interface Frame {
  kind: '{' | '['
  path: JsonPath
  key: string | null
  index: number
  files: boolean
}
interface CapturedFile {
  path: JsonPath
  value: unknown
}

/** 只把包目录骨架留给流式扫描；每个文件交给原生 JSON.parse 创建紧凑对象。 */
class GoProjectJsonReader {
  private readonly frames: Frame[] = []

  private readonly skeleton: string[] = []

  private readonly captured: CapturedFile[] = []

  private readonly strings = new Map<string, string>()

  // 目录骨架中的字符串状态，与单文件捕获状态分别跨块保存。
  private headerQuoted = false

  private headerEscaped = false

  private headerToken = ''

  // fileDepth 大于零时正在捕获一个文件对象，内容不再进入骨架扫描。
  private fileDepth = 0

  private fileQuoted = false

  private fileEscaped = false

  private filePath: JsonPath = []

  private filePieces: string[] = []

  /**
   * 只复用不可变的路径/类型字符串；节点、loc 和元数据对象仍各自独立。
   * @param text 完整单文件 JSON
   * @returns {unknown} 保持全部字段的文件对象
   */
  private decodeFile(text: string): unknown {
    const result = JSON.parse(text)
    const pending = [result]
    while (pending.length) {
      const object = pending.pop()
      for (const key of Object.keys(object)) {
        const value = object[key]
        if (typeof value === 'string' && (key === 'sourcefile' || key === 'type' || key === 'literalType')) {
          const existing = this.strings.get(value)
          if (existing !== undefined) object[key] = existing
          else this.strings.set(value, value)
        } else if (value && typeof value === 'object') pending.push(value)
      }
    }
    return result
  }

  /**
   * 当前值在完整返回对象中的路径。
   * @returns {JsonPath} 对象键和数组下标组成的路径
   */
  private valuePath(): JsonPath {
    const parent = this.frames[this.frames.length - 1]
    return parent ? [...parent.path, parent.kind === '[' ? parent.index : parent.key!] : []
  }

  /**
   * 处理骨架中的字符串、键和容器；文件节点内部不走此路径。
   * @param char 当前字符串字符
   */
  private consumeHeaderString(char: string): void {
    this.headerToken += char
    if (this.headerEscaped) this.headerEscaped = false
    else if (char === '\\') this.headerEscaped = true
    else if (char === '"') this.headerQuoted = false
  }

  /**
   * 处理文件外部的目录和模块字段。
   * @param char 当前字符
   */
  private consumeHeaderCharacter(char: string): void {
    if (this.headerQuoted) {
      this.consumeHeaderString(char)
      return
    }
    if (char === '"') {
      this.headerQuoted = true
      this.headerToken = char
      return
    }
    const parent = this.frames[this.frames.length - 1]
    if (char === ':') parent.key = JSON.parse(this.headerToken)
    else if (char === ',') {
      if (parent.kind === '[') parent.index++
      else parent.key = null
    } else if (char === '{' || char === '[') {
      this.frames.push({
        kind: char,
        path: this.valuePath(),
        key: null,
        index: 0,
        files: char === '{' && parent?.key === 'files',
      })
    } else if (char === '}' || char === ']') this.frames.pop()
  }

  /**
   * 跟踪文件 JSON 的结构边界；括号和引号出现在字符串内时不计入深度。
   * @param char 当前文件内容字符
   */
  private consumeFileCharacter(char: string): void {
    if (this.fileQuoted) {
      if (this.fileEscaped) this.fileEscaped = false
      else if (char === '\\') this.fileEscaped = true
      else if (char === '"') this.fileQuoted = false
    } else if (char === '"') this.fileQuoted = true
    else if (char === '{' || char === '[') this.fileDepth++
    else if (char === '}' || char === ']') this.fileDepth--
  }

  /**
   * 消费 UTF-8 解码后的块，可在任意字符边界分块。
   * @param text 已解码的输入块
   */
  feed(text: string): void {
    let outsideStart = 0
    let fileStart = 0
    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      if (this.fileDepth > 0) {
        this.consumeFileCharacter(char)
        if (this.fileDepth === 0) {
          this.filePieces.push(text.slice(fileStart, i + 1))
          this.captured.push({ path: this.filePath, value: this.decodeFile(this.filePieces.join('')) })
          this.filePieces = []
          outsideStart = i + 1
        }
      } else if (!this.headerQuoted && char === '{' && this.frames[this.frames.length - 1]?.files) {
        this.skeleton.push(text.slice(outsideStart, i), 'null')
        this.filePath = this.valuePath()
        this.fileDepth = 1
        this.fileQuoted = false
        this.fileEscaped = false
        fileStart = i
      } else this.consumeHeaderCharacter(char)
    }
    if (this.fileDepth > 0) this.filePieces.push(text.slice(fileStart))
    else this.skeleton.push(text.slice(outsideStart))
  }

  /**
   * 按原始 JSON 路径挂接文件对象；不删除、重排或规范化字段。
   * @returns {any} 完整原生项目结果
   */
  finish(): any {
    if (this.fileDepth || this.headerQuoted) throw new SyntaxError('Incomplete Go project JSON')
    const result = JSON.parse(this.skeleton.join(''))
    for (const file of this.captured) {
      let parent = result
      for (const key of file.path.slice(0, -1)) parent = parent[key]
      Object.defineProperty(parent, file.path[file.path.length - 1], {
        value: file.value,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return result
  }
}

/**
 * 逐文件读取原生 Go 输出；I/O 和 JSON 错误向调用者传播，不能返回部分项目。
 * @param file 原生输出文件路径
 * @param chunkBytes 输入块字节数，测试可缩小以覆盖边界
 * @returns {any} 完整原生项目结果
 */
export default async function readGoProjectJson(file: string, chunkBytes = 64 * 1024): Promise<any> {
  const reader = new GoProjectJsonReader()
  const decoder = new StringDecoder('utf8')
  for await (const chunk of fs.createReadStream(file, { highWaterMark: chunkBytes }))
    reader.feed(decoder.write(chunk as Buffer))
  reader.feed(decoder.end())
  return reader.finish()
}
