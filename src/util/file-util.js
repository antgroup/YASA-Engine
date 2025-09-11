const fs = require('fs')
const jsonfile = require('jsonfile')
const path = require('path')
const _ = require('lodash')

const logger = require('./logger')(__filename)
const stat = require('./statistics')
const globby = require('fast-glob')

const astCache = {}
const useASTCache = false
const config = require('../config')
const { handleException } = require('../engine/analyzer/common/exception-handler')

// e.g. for printing source lines
/**
 *
 * @param filename
 * @param lineNumbers
 */
function readLinesSync(filename, lineNumbers) {
  const lines = []
  if (_.isArray(lineNumbers) && lineNumbers) {
    let data
    try {
      filename = filename.toString()
      if (useASTCache) {
        // check cache first
        const cache = astCache[filename]
        if (cache) data = cache.content
        else {
          data = fs.readFileSync(filename, 'utf8')
          astCache[filename] = { content: data }
        }
      } else data = fs.readFileSync(filename, 'utf8')
    } catch (e) {
      return []
    }
    // var allLines = data.split(/\n|\r/);
    const allLines = data.split(/\n/)
    for (let i = 0; i < lineNumbers.length; i++) {
      let lineNumber = lineNumbers[i]
      if (lineNumber > allLines.length) {
        handleException(
          null,
          `Attempt to read line [${lineNumber}] in the file [${filename}] of which max line is [${allLines.length}]`,
          `Attempt to read line [${lineNumber}] in the file [${filename}] of which max line is [${allLines.length}]`
        )
        break
      }
      lines.push({
        line: lineNumber,
        code: allLines[--lineNumber],
      })
    }
  }
  return lines
}

//* *****************************  Text file ***********************************

/**
 * recursively load the bodies of all the files under the current path/file
 * @param filename file or directory to load.
 *        If directory, recur and load all files not excluded by nameFilter
 * @param nameFilter: array of strings that the filename should end with
 * @param dirFilter: array of strings that the directory shouldn't contained
 * @param extExcludes: array of strings that the filename should not end with
 * @param nameFilter
 * @param dirFilter
 * @param extExcludes
 * @returns list of records of the form { fileName , fileContent }
 */
function loadAllFileText(filename, nameFilter, dirFilter, extExcludes) {
  const res = []
  const parsingStart = new Date().getTime()
  loadFileTextRec(filename, nameFilter, dirFilter, res, extExcludes)
  const parsingEnd = new Date().getTime()
  stat.parsingTime += parsingEnd - parsingStart
  return res
}

// globby version of load all file text
/**
 *
 * @param srcFilter
 * @param cwd
 */
function loadAllFileTextGlobby(srcFilter, cwd) {
  const res = []

  const parsingStart = new Date().getTime()
  const files = globby.sync(srcFilter, { cwd })
  for (const file of files) {
    const filepath = path.join(cwd, file)
    const content = fs.readFileSync(filepath, 'utf8')
    res.push({ file: filepath, content })
  }

  stat.parsingTime += new Date().getTime() - parsingStart
  return res
}

/**
 * load the source recursively (by going into subdirectories)
 * @param filename the file to be considered (may be a directory or proper file)
 * @param nameFilter if the file doesn't ends in one of these strings, skip it
 * @param dirFilter: if the directory in there strings, skip it
 * @param extExcludes: if the file ends in one of these strings, skip it, prior than nameFilter
 * @param dirFilter
 * @param res accumulator list.  Added to by side-effect
 * @param extExcludes
 */
function loadFileTextRec(filename, nameFilter, dirFilter, res, extExcludes) {
  let fileStat
  try {
    fileStat = fs.lstatSync(filename)
  } catch (e) {
    // logger.info(e);
  }
  // logger.info('name: ' + filename);

  if (fileStat && fileStat.isDirectory()) {
    // logger.info('path: ' + path_string);
    const dir = filename
    if (
      dirFilter &&
      dirFilter.some(function (filter) {
        return path.basename(dir) === filter
      })
    ) {
      return
    }
    const files = fs.readdirSync(dir)
    for (const i in files) {
      const name = `${dir}/${files[i]}`
      loadFileTextRec(name, nameFilter, dirFilter, res, extExcludes)
    }
  } else {
    if (nameFilter && !nameFilter.some((filter) => filename.endsWith(filter))) return
    if (extExcludes && extExcludes.some((filter) => filename.endsWith(filter))) return
    try {
      // var contents = fs.readFileSync(filename, 'utf-8');
      let contents
      if (useASTCache) {
        const cache = astCache[filename]
        if (cache) contents = cache.content
        else {
          contents = fs.readFileSync(filename, 'utf8')
          astCache[filename] = { content: contents }
        }
      } else contents = fs.readFileSync(filename, 'utf8')
      res.push({ file: filename, content: contents })
    } catch (e) {}
  }
}

//* ***************************** Source in JSON ***********************************

// load and parse JSON files
/**
 *
 * @param filename
 */
function loadJsonFileAsts(filename) {
  const path_string = filename
  let fileStat
  let ast
  try {
    fileStat = fs.lstatSync(path_string)
  } catch (e) {}

  if (fileStat && fileStat.isDirectory()) {
    // logger.info('path: ' + path_string);
    const dir = path_string
    let res = []
    const files = fs.readdirSync(dir)
    for (let i = 0; i < files.length; i++) {
      const name = `${dir}/${files[i]}`
      if (fs.statSync(name).isDirectory()) {
        // go into the subdirectories
        const sub_res = loadJsonFileAsts(name)
        res = res.concat(sub_res)
        continue
      }

      const lastDotIndex = name.lastIndexOf('.')
      if (lastDotIndex === -1 || lastDotIndex === name.length - 1) {
        continue
      }
      const fileExtension = name.substring(lastDotIndex + 1)
      if (fileExtension !== 'json') {
        continue
      }

      ast = loadJSONfile(name)
      res.push({
        file: filename,
        ast,
        language: constants.Language.JAVA,
      })
    }
    return res
  }
  // logger.info('file: ' + path_string);
  if (filename.indexOf('.json') === -1) {
    filename += '.json'
  }

  ast = loadJSONfile(filename)
  if (!ast) return fast

  logger.info(`loaded: ${filename}`)
  if (Array.isArray(ast)) {
    return ast.map(function (unit) {
      return { ast: unit }
    })
  }
  return {
    file: filename,
    ast,
  }
}

// write JSON into a file
/**
 *
 * @param filename
 * @param value
 */
function writeJSONfile(filename, value) {
  // logger.info('writing JSON file: ' + filename);
  jsonfile.writeFile(filename, value, {}, function (err) {
    if (err)
      handleException(err, 'Error occurred in file-util.writeJSONfile', 'Error occurred in file-util.writeJSONfile')
  })
}

// from file to memory
/**
 *
 * @param filename
 */
function loadJSONfile(filename) {
  if (!fs.existsSync(filename)) {
    handleException(
      null,
      `loading JSON file error: ${filename}. File does not exist`,
      `loading JSON file error: ${filename}. File does not exist`
    )
    process.exit(1)
  }
  try {
    const res = jsonfile.readFileSync(filename)
    return res
  } catch (e) {
    handleException(e, `jsonfile parse error:${filename}`, `jsonfile parse error:${filename}`)
    process.exit(1)
  }
}

//* *****************************  Others ************************************

// Recurse into a directory to find a file with the given name
/**
 *
 * @param rootdir
 * @param tofind
 * @param subdir
 */
function findfile(rootdir, tofind, subdir) {
  const abspath = subdir ? path.join(rootdir, subdir) : rootdir
  const files = fs.readdirSync(abspath)
  for (let i = 0; i < files.length; i++) {
    const filename = files[i]
    if (tofind instanceof RegExp) {
      if (tofind.test(filename)) return true
    } else if (filename === tofind) return true
    const filepath = path.join(abspath, filename)
    try {
      if (fs.statSync(filepath).isDirectory()) {
        if (findfile(rootdir, tofind, path.join(subdir || '', filename || ''))) return true
      }
    } catch (e) {}
  }
  return false
}

// FIXME: share code with above functions
// obtain recursively the files with the given extension and not included in the given list
/**
 *
 * @param absPath
 * @param file_ex
 * @param excluded
 */
function getFilesInDirectory(absPath, file_ex, excluded) {
  const sourcePath = absPath
  let fileStat
  try {
    fileStat = fs.lstatSync(sourcePath)
  } catch (e) {
    logger.info('directory not found')
  }

  if (fileStat) {
    if (fileStat.isDirectory()) {
      let res = []
      const files = fs.readdirSync(sourcePath)
      for (const i in files) {
        const name = `${sourcePath}/${files[i]}`

        const stat = fs.lstatSync(name)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) {
          // go into the subdirectories
          if (excluded && excluded.indexOf(files[i]) !== -1) continue
          const sub_res = getFilesInDirectory(name, file_ex, excluded)
          res = res.concat(sub_res)
          continue
        }

        const j = name.lastIndexOf('.')
        if (j == -1 || j == name.length - 1) {
          continue
        }
        const fileExtension = name.substring(j + 1)
        if (fileExtension !== file_ex) continue
        res.push(name)
      } // end for
      return res
    }
    // logger.info('File to analyze: ' + sourcePath);
    const i = sourcePath.lastIndexOf('.')
    if (i == -1 || i == sourcePath.length - 1) return
    const fileExtension = sourcePath.substring(i + 1)
    if (fileExtension !== file_ex) return
    return [sourcePath]
  }
}

/**
 *
 * @param absdirs
 * @param options
 * @returns {Array}
 */
function loadSource(absdirs, options) {
  let srcFilter = ['**/*.sol']
  // var dirFilter = [];
  // let ext_excludes = [];

  switch (options.language) {
    case 'golang':
      srcFilter = ['**/*.go', '!**/vendor']
      // dirFilter.push("vendor");
      break
    case 'javascript':
    case 'js':
      srcFilter = [
        '**/*.(js|ts|mjs|cjs)',
        '!**/*.test.(js|ts|mjs|cjs|jsx)',
        '!**/node_modules',
        '!**/app/public',
        '!**/*.d.ts',
        '!**/*.d.js',
      ]
      // ext_excludes.push(...['.test.js', '.test.ts', '.test.mjs', '.test.cjs', '.test.jsx']);
      // dirFilter.push("node_modules");
      break
  }
  const res = []
  for (const dir of absdirs) {
    const files = globby.sync(srcFilter, { cwd: dir })
    files.length
  }

  // const res = [];
  // for (let dir of absdirs) {
  //     const srcTxts = loadAllFileText(dir, Array.isArray(fext)? fext : [fext], dirFilter, ext_excludes);
  //     for (let txt of srcTxts) {
  //         // txt: { file: ..., content: ... }
  //         res.push(txt);
  //     }
  // }
  // return res;
}

/**
 *
 * @param fullString
 * @param subString
 */
function extractAfterSubstring(fullString, subString) {
  if (fullString) {
    const index = fullString?.indexOf(subString)
    if (index === -1) {
      // 如果 fullString 中不包含 subString，返回原字符串或空字符串
      return '' // 或者 fullString，根据你的需求
    }
    // 返回从 subString 之后的部分
    return removeBeforeFirstSlash(fullString.substring(index + subString.length))
  }
}

/**
 *
 * @param fullPath
 * @param dir
 */
function extractRelativePath(fullPath, dir) {
  if (!fullPath) {
    return null
  }
  let relativePath = fullPath.substring(dir.length)
  if (!relativePath.startsWith('/')) {
    relativePath = `/${relativePath}`
  }
  return relativePath
}

/**
 *
 * @param relativePath
 * @param dir
 */
function assembleFullPath(relativePath, dir) {
  if (relativePath.startsWith(dir)) {
    return relativePath
  }
  if (!relativePath.startsWith('/')) {
    relativePath = `/${relativePath}`
  }
  return (dir + relativePath).replaceAll('\/\/', '/')
}

/**
 *
 * @param str
 */
function removeBeforeFirstSlash(str) {
  // 找到第一个'/'的索引
  const index = str.indexOf('/')

  // 如果找到了'/'，则从该位置开始截取字符串；否则返回原字符串
  if (index !== -1) {
    return str.substring(index)
  }
  return str // 如果没有找到'/'，则返回原始字符串
}

/**
 *
 * @param sourcefile
 * @param fname
 */
function normalizeAndJoin(sourcefile, fname) {
  if (fname.startsWith('.')) {
    const splitIndex = fname.indexOf('/') !== -1 ? fname.indexOf('/') : fname.length
    const leadingDots = fname.slice(0, splitIndex).replace(/\.(?=[a-zA-Z])/g, './')
    const remainingPath = fname.slice(splitIndex + 1)

    // 拼接路径：处理 ".." 或 "."，再拼接剩余部分
    return customJoin(sourcefile, leadingDots, remainingPath)
  }
  return path.resolve(config.maindir, fname)
}

/**
 *
 * @param {...any} segments
 */
function customJoin(...segments) {
  // 处理路径数组并展开所有分段
  const parts = []
  segments.forEach((segment) => {
    parts.push(...segment.split(path.sep))
  })

  const finalStack = []

  for (const part of parts) {
    if (part === '' || part === '.') {
      continue
    } else if (part.startsWith('..')) {
      // 自定义逻辑处理 `..` 或更多点层级
      for (let i = 0; i < part.length - 1; i++) {
        finalStack.pop()
      }
    } else {
      // 普通目录，压入到最终路径的栈中
      finalStack.push(part)
    }
  }

  // 使用 path.join() 生成标准化的路径
  return `/${path.join(...finalStack)}`
}

/**
 *
 * @param str
 */
function removeBeforeFirstSlash(str) {
  // 找到第一个'/'的索引
  const index = str.indexOf('/')

  // 如果找到了'/'，则从该位置开始截取字符串；否则返回原字符串
  if (index !== -1) {
    return str.substring(index)
  }
  return str // 如果没有找到'/'，则返回原始字符串
}

/**
 *
 * @param fullString
 * @param subString
 */
function extractAfterSubstring(fullString, subString) {
  if (fullString) {
    const index = fullString?.indexOf(subString)
    if (index === -1) {
      // 如果 fullString 中不包含 subString，返回原字符串或空字符串
      return '' // 或者 fullString，根据你的需求
    }
    // 返回从 subString 之后的部分
    return removeBeforeFirstSlash(fullString.substring(index + subString.length))
  }
}

/**
 * remove the shared prefix of the file paths
 * @param original
 * @param path_prefix
 * @returns {*}
 */
function shortenSourceFile(original, path_prefix) {
  if (path_prefix) {
    if (original.startsWith(path_prefix)) {
      return original.substring(path_prefix.length)
    }
  }
  return original
}

/**
 *
 * @param p
 */
function getAbsolutePath(p) {
  if (path.isAbsolute(p)) {
    return p
  }
  let res = path.join(require.main.filename, '../../', p)
  if (fs.existsSync(res)) {
    return res
  }
  res = path.join(process.cwd(), p)
  return res
}
//* *****************************  exports **************************

module.exports = {
  loadAllFileText,
  loadAllFileTextGlobby,
  writeJSONfile,
  loadJSONfile,
  readLinesSync,
  findfile,
  getFilesInDirectory,
  loadSource,
  removeBeforeFirstSlash,
  extractAfterSubstring,
  extractRelativePath,
  assembleFullPath,
  normalizeAndJoin,
  shortenSourceFile,
  getAbsolutePath,
  removeFileFromCache(fname) {
    if (useASTCache) delete astCache[fname]
  },
}
