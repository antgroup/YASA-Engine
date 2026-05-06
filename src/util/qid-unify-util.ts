interface SymbolLike {
  qid?: string
  vtype?: string
  sid?: string
  [key: string]: any
}

/**
 * 统一各语言的qid
 */
class QidUnifyUtil {
  symbol: SymbolLike | undefined

  value: string

  /**
   * 构造函数：可以接受 SymbolLike 对象或字符串
   * @param symbolOrValue SymbolLike 对象或字符串
   */
  constructor(symbolOrValue?: SymbolLike | string) {
    if (typeof symbolOrValue === 'string') {
      // 如果传入的是字符串，直接使用
      this.symbol = undefined
      this.value = symbolOrValue
    } else {
      // 如果传入的是 SymbolLike 对象
      this.symbol = symbolOrValue
      this.value = symbolOrValue?.qid || ''
    }
  }

  /**
   * 统一路径形式，将开头的"/"去掉，并将每一层目录替换成".", 即 /tp/2.func ==> tp.2.func
   */
  removePath(): QidUnifyUtil {
    this.value = this.value?.replace(/^\//, '').replace(/\//g, '.')
    return this
  }

  /**
   * python中找不到import时，会以"syslib_from."开头
   */
  removeSyslibFrom(): QidUnifyUtil {
    if (this.value.startsWith('syslib_from.')) {
      this.value = this.value.replace('syslib_from.', '')
    }
    return this
  }

  /**
   * js-chair框架会将agg替换成Egg.Application，将ctx替换成Egg.Context，替换回来
   */
  removeChair(): QidUnifyUtil {
    this.value = this.value.replace('Egg.Application', 'app')
    this.value = this.value.replace('Egg.Context', 'ctx')
    return this
  }

  /**
   * 去除所有的括号及括号内内容（包括嵌套）——更通用的情况
   */
  removeParentheses(): QidUnifyUtil {
    let result = ''
    let level = 0
    for (const char of this.value) {
      if (char === '(') {
        level++
      } else if (char === ')') {
        if (level > 0) level--
      } else if (level === 0) {
        result += char
      }
    }
    this.value = result
    return this
  }

  /**
   * remove *_scope.<block_>写法，即1.calculate.calculate_scope.<block_18_4_34_51>.process ==> 1.calculate.process
   */
  removeBlock(): QidUnifyUtil {
    if (
      !this.value.includes('<block') &&
      !this.value.includes('<fileblock_') &&
      !this.value.includes('<object') &&
      !this.value.includes('__tmp')
    ) {
      return this
    }

    // 当符号值类型为symbol时，直接返回sid
    if (this.symbol?.vtype === 'symbol') {
      this.value = this.symbol?.sid || ''
      return this
    }

    const temp = this.value.split('.')
    const result: string[] = []
    for (let i = 0; i < temp.length; i++) {
      const curStr = temp[i]
      const preStr = i > 0 ? temp[i - 1] : 'NaN'
      if (curStr === `${preStr}_scope`) {
        continue
      }
      // 移除掉多余的<block>
      if (
        curStr.startsWith('<block') ||
        curStr.startsWith('<fileblock_') ||
        curStr.startsWith('<object_') ||
        curStr.startsWith('__tmp')
      ) {
        continue
      }
      result.push(curStr)
    }
    this.value = result.join('.')
    return this
  }

  /**
   * 类的实例会表示成*.<instance_xxx_xxx_..._endtag>.,去掉instance标签
   */
  removeInstance(): QidUnifyUtil {
    // 匹配以 <instance_ 开头，以 _endtag> 结尾的字符串（中间可能包含 >，但不包含 .）
    // 使用非贪婪匹配 [^.]*? 来匹配最短的从 <instance_ 到 _endtag> 的内容，排除 .
    this.value = this.value.replace(/<instance_[^.]*?_endtag>/g, '')
    return this
  }

  /**
   * 流敏感给不同符号值制作拷贝时会添加<copied>标签
   */
  removeCopied(): QidUnifyUtil {
    this.value = this.value.replace(/<copied[^.]*?_endtag>/g, '')
    return this
  }

  /**
   * 统一去掉cloned
   */
  removeCloned(): QidUnifyUtil {
    this.value = this.value.replace(/<cloned[^.]*?_endtag>/g, '')
    return this
  }

  /**
   * 统一去掉<global>
   */
  removeGlobal(): QidUnifyUtil {
    this.value = this.value
      .replace('<global>.', '')
      .replace('packageManager.', '')
      .replace('moduleManager.', '')
      .replace('fileManager.', '')
    return this
  }

  /**
   * 获取当前的值
   */
  get(): string {
    return this.value
  }

  /**
   * 静态方法，用于在QL中格式化qid
   * @param symbolOrValue SymbolLike 对象或字符串
   */
  static qidUnifyForQL(symbolOrValue?: SymbolLike | string): string {
    if (typeof symbolOrValue === 'string') {
      // 如果传入的是字符串，直接处理
      return new QidUnifyUtil(symbolOrValue)
        .removePath()
        .removeChair()
        .removeParentheses()
        .removeBlock()
        .removeInstance()
        .removeCopied()
        .removeGlobal()
        .removeCloned()
        .removeSyslibFrom()
        .get()
    }
    let unifyID = symbolOrValue?.qid || ''
    if (symbolOrValue?.vtype !== 'primitive' && symbolOrValue?.vtype !== 'uninitialized') {
      unifyID = new QidUnifyUtil(symbolOrValue)
        .removePath()
        .removeChair()
        .removeParentheses()
        .removeBlock()
        .removeInstance()
        .removeCopied()
        .removeCloned()
        .removeGlobal()
        .removeSyslibFrom()
        .get()
    }
    return unifyID
  }

  /**
   * 静态方法，用于在yasa中格式化qid
   * @param symbolOrValue SymbolLike 对象或字符串
   */
  static qidUnifyByRemoveAngleAndPrefix(symbolOrValue?: SymbolLike | string): string {
    if (typeof symbolOrValue === 'string') {
      // 如果传入的是字符串，直接处理
      return new QidUnifyUtil(symbolOrValue)
        .removeBlock()
        .removeInstance()
        .removeCopied()
        .removeGlobal()
        .removeSyslibFrom()
        .removeCloned()
        .get()
    }
    let unifyID = symbolOrValue?.qid || ''
    if (symbolOrValue?.vtype !== 'primitive' && symbolOrValue?.vtype !== 'uninitialized') {
      unifyID = new QidUnifyUtil(symbolOrValue)
        .removeBlock()
        .removeInstance()
        .removeCopied()
        .removeGlobal()
        .removeSyslibFrom()
        .removeCloned()
        .get()
    }
    return unifyID
  }

  /**
   * 静态方法，用于去掉字符串中的 instance 标签
   * @param value 要处理的字符串
   * @returns 处理后的字符串
   */
  static removeInstanceFromString(value: string): string {
    return new QidUnifyUtil(value).removeInstance().removeCopied().get()
  }

  /**
   * 静态方法，去掉字符串中的圆括号及其内容
   * @param value 要处理的字符串
   */
  static removeParenthesesFromString(value: string): string {
    return new QidUnifyUtil(value).removeParentheses().get()
  }
}

module.exports = QidUnifyUtil
