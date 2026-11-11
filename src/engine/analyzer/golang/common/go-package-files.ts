/** 目录树中的文件保留各自的 Go package 名，外部测试包不得混入生产包。 */
export interface GoPackageFile {
  node: any
  packageName: string
}

/**
 * 按包名稳定分组，同一包内按文件名排序。
 * @param files 目录下逐文件的 UAST 与包名。
 * @returns {Map<string, GoPackageFile[]>} 按名称排序的包分组。
 */
export function groupGoPackageFiles(files: Record<string, GoPackageFile>): Map<string, GoPackageFile[]> {
  const groups = new Map<string, GoPackageFile[]>()
  for (const file of Object.keys(files).sort()) {
    const info = files[file]
    const entries = groups.get(info.packageName) || []
    entries.push(info)
    groups.set(info.packageName, entries)
  }
  return new Map(
    [...groups.entries()].sort(([a], [b]) => {
      if (a === b) return 0
      return a < b ? -1 : 1
    })
  )
}

/**
 * import 路径对应非外部测试包；仅有测试包时保留其独立扫描能力。
 * @param groups 按包名排序的文件分组。
 * @returns {string | undefined} 目录 import 使用的包名，空目录返回 undefined。
 */
export function primaryGoPackageName(groups: Map<string, GoPackageFile[]>): string | undefined {
  const names = [...groups.keys()]
  return names.find((name) => !name.endsWith('_test') && name !== '__global__') || names[0]
}

/**
 * 为生产包和外部测试包建立独立的分析作用域。
 * @param groups 按包名分组的文件。
 * @param currentScope 当前目录对应的作用域。
 * @param topScope 全局作用域。
 * @returns {Map<string, any>} 包名到分析作用域的映射。
 */
export function createGoPackageScopes(
  groups: Map<string, GoPackageFile[]>,
  currentScope: any,
  topScope: any
): Map<string, any> {
  const primaryName = primaryGoPackageName(groups)
  const scopes = new Map<string, any>()
  for (const name of groups.keys()) {
    let scope = currentScope
    if (name === '__global__') scope = topScope
    else if (name !== primaryName) scope = currentScope.getSubPackage(`%package_${name}`, true)
    if (!scope.name) scope.name = name
    scopes.set(name, scope)
  }
  return scopes
}
