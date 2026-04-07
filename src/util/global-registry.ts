// 全局注册表：AST 管理器 + 符号表管理器
// 从 ast-util.ts 提取，打破 unit.ts ↔ ast-util.ts 循环依赖

let globalASTManager: any = null
let globalSymbolTable: any = null

function setGlobalASTManager(astManager: any): void {
  globalASTManager = astManager
}

function getGlobalASTManager(): any {
  return globalASTManager
}

function setGlobalSymbolTable(symbolTable: any): void {
  globalSymbolTable = symbolTable
}

function getGlobalSymbolTable(): any {
  return globalSymbolTable
}

module.exports = {
  setGlobalASTManager,
  getGlobalASTManager,
  setGlobalSymbolTable,
  getGlobalSymbolTable,
}
