const is = require('is-type-of')
const { handleException } = require('../engine/analyzer/common/exception-handler')

type CaseStyle = 'lower' | 'upper' | 'camel' | ((filepath: string) => string[])

// convert file path to an array of properties
// a/b/c.js => ['a', 'b', 'c']
/**
 *
 * @param filepath
 * @param root0
 * @param root0.caseStyle
 */
function getFilePathProperties(filepath: string, { caseStyle }: { caseStyle: CaseStyle }): string[] {
  // if caseStyle is function, return the result of function
  if (typeof caseStyle === 'function') {
    const result = caseStyle(filepath)
    if (!is.array(result)) {
      throw new Error(`caseStyle expect an array, but got ${result}`)
    }
    return result
  }
  // use default camelize
  return defaultCamelize(filepath, caseStyle)
}

/**
 *
 * @param filepath
 * @param caseStyle
 */
function defaultCamelize(filepath: string, caseStyle: 'lower' | 'upper' | 'camel'): string[] {
  if (typeof filepath !== 'string') {
    return []
  }
  const properties = filepath.substring(0, filepath.lastIndexOf('.')).split('/')
  return properties.map((property) => {
    // if(property.includes(".")){ // 去掉.并使其后面一个字母大写，如test.controller.ts变为testController
    //     let parts = property.split('.');
    //     property = parts.map((part, index) => {
    //         if (index === 0) {
    //             return part;
    //         } else {
    //             return part.charAt(0).toUpperCase() + part.slice(1);
    //         }
    //     }).join('');
    // }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(property)) {
      handleException(
        new Error(`${property} is not match 'a-z0-9_-' in ${filepath}`),
        `Error: ${property} is not match 'a-z0-9_-' in ${filepath}`,
        `Error: ${property} is not match 'a-z0-9_-' in ${filepath}`
      )
      process.exit(1)
    }

    // use default camelize, will capitalize the first letter
    // foo_bar.js > FooBar
    // fooBar.js  > FooBar
    // FooBar.js  > FooBar
    // FooBar.js  > FooBar
    // FooBar.js  > fooBar (if lowercaseFirst is true)
    property = property.replace(/[_-][a-z]/gi, (s) => s?.substring(1).toUpperCase())
    let first = property[0]
    switch (caseStyle) {
      case 'lower':
        first = first.toLowerCase()
        break
      case 'upper':
        first = first.toUpperCase()
        break
      case 'camel':
      default:
    }
    return first + property.substring(1)
  })
}

// convert packageName to an array of properties
// com.alipay.a.b.c => ['com','alipay','a', 'b','c']
/**
 *
 * @param packageName
 */
function getPackageNameProperties(packageName: string): string[] {
  return packageName.split('.')
}

export { getFilePathProperties, getPackageNameProperties }
