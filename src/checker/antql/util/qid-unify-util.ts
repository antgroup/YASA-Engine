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
   * 需要传符号值
   * @param symbol
   */
  constructor(symbol?: SymbolLike) {
    this.symbol = symbol
    this.value = symbol?.qid || ''
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
    if (!this.value.includes('<block')) {
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
      if (curStr.startsWith('<block')) {
        continue
      }
      result.push(curStr)
    }
    this.value = result.join('.')
    return this
  }

  /**
   * 类的实例会表示成*.<instance>.,去掉<instance>
   */
  removeInstance(): QidUnifyUtil {
    this.value = this.value.replace('<instance>', '')
    return this
  }

  /**
   * 统一去掉<global>
   */
  removeGlobal(): QidUnifyUtil {
    this.value = this.value.replace('<global>.', '')
    return this
  }

  /**
   * 获取当前的值
   */
  get(): string {
    return this.value
  }

  /**
   * 静态方法，用于调用上面所有的方法，一步到位统一符号值qid
   * @param symbol
   */
  static unify(symbol?: SymbolLike): string {
    let unifyID = symbol?.qid || ''
    if (symbol?.vtype !== 'primitive' && symbol?.vtype !== 'uninitialized') {
      unifyID = new QidUnifyUtil(symbol)
        .removePath()
        .removeSyslibFrom()
        .removeChair()
        .removeParentheses()
        .removeBlock()
        .removeInstance()
        .removeGlobal()
        .get()
    }
    return unifyID
  }
}

module.exports = QidUnifyUtil
