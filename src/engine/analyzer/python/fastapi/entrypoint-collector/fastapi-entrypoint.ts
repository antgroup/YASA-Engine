const { extractRelativePath } = require('../../../../../util/file-util')
const { entryPointAndSourceAtSameTime } = require('../../../../../config')
const { findSourceOfFuncParam } = require('../../common/entrypoint-collector/python-entrypoint-source')
const EntryPoint = require('../../../common/entrypoint')
const Constant = require('../../../../../util/constant')

interface ASTObject {
  body?: any[]
  [key: string]: any
}

interface FilenameAstMap {
  [filename: string]: ASTObject
}

const ROUTE_DECORATORS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'route'])

function extractLiteralString(node: any): string | null {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value
  }
  return null
}

function extractRouteParams(route: string | null): string[] {
  if (!route) return []
  const regex = /\{(.*?)\}/g
  const params: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(route)) !== null) {
    const name = match[1].split(':').pop()
    if (name) params.push(name)
  }
  return params
}

function extractVarNameAndInit(obj: any): { varName?: string; init?: any } | null {

  try {
    if (obj.type === 'VariableDeclaration') {
      return { varName: obj.id?.name, init: obj.init }
    }
    if (obj.type === 'AssignmentExpression' && obj.operator === '=') {
      if (obj.left?.type === 'Identifier') {
        return { varName: obj.left.name, init: obj.right }
      }
    }
  } catch {  }
  return null
}

 
function extractPrefixFromArgs(args: any[]): string {
  let prefix = ''
  if (!Array.isArray(args)) return prefix

  for (const arg of args) {
  

    if (!arg || typeof arg !== 'object') continue

    if (arg.type === 'Literal' && typeof arg.value === 'string') {
      prefix = arg.value
      continue
    }
    if (arg.type === 'VariableDeclaration' && arg.id?.name === 'prefix') {
      const value = extractLiteralString(arg.init)
      if (value) prefix = value
      continue
    }

  }

  return prefix
}

function findFastApiEntryPointAndSource(filenameAstObj: FilenameAstMap, dir: string) {
  const entryPoints: (typeof EntryPoint)[] = [];
  const entryPointSources: any[] = [];
  for (const filename in filenameAstObj) {
    const fileObj = filenameAstObj[filename];
    if (!fileObj?.body) continue;

    const body = fileObj.body;

    const routerPrefixes: Record<string, string> = {};

    const relativeFile = filename.startsWith(dir)
      ? extractRelativePath(filename, dir)
      : filename;

    for (const obj of body) {
      if (!obj || typeof obj !== "object") continue;
      //1. 解析 router = APIRouter(prefix="/xxx")
      if (
        obj.type === "VariableDeclaration" ||
        (obj.type === "AssignmentExpression" && obj.operator === "=")
      ) {
        const varInfo = extractVarNameAndInit(obj);
        if (!varInfo?.varName || !varInfo.init) continue;
        const init = varInfo.init;

        if (init.type === "CallExpression") {
          const callee = init.callee;
          if (callee?.type === "Identifier" && callee.name === "APIRouter") {
            const prefix = extractPrefixFromArgs(init.arguments || []);
            routerPrefixes[varInfo.varName] = prefix || "";
          }
        }
        continue;
      }
      //2. 解析 app.include_router(router, prefix="/xxx")
      if (obj.type === "ExpressionStatement") {
        const expr = obj.expression;
        if (expr?.type !== "CallExpression") continue;

        const callee = expr.callee;

        if (callee?.type === "MemberAccess" && callee.property?.name === "include_router") {
          const args = expr.arguments || [];
          const routerArg = args[0];

          if (routerArg?.type === "Identifier") {
            const routerName = routerArg.name;
            const includePrefix = extractPrefixFromArgs(args.slice(1));

            if (includePrefix) {
              const existing = routerPrefixes[routerName] || "";
              routerPrefixes[routerName] = includePrefix + existing;
            }
          }
        }
        continue;
      }

       //3. 解析 FastAPI 路由函数定义：@router.get("/path")

      if (obj.type === "FunctionDefinition" && obj._meta?.decorators && obj.id?.name) {
        const funcName = obj.id.name;
        const decorators = obj._meta.decorators;

        for (const deco of decorators) {
          if (!deco || deco.type !== "CallExpression") continue;
          const callee = deco.callee;

          if (!callee || callee.type !== "MemberAccess") continue;

          const methodName = callee.property?.name;
          if (!methodName || !ROUTE_DECORATORS.has(methodName)) continue;

          let routerName = "";
          if (callee.object?.type === "Identifier") {
            routerName = callee.object.name;
          }
          const routePath = extractLiteralString(deco.arguments?.[0]);
          const params = extractRouteParams(routePath);

          const prefix = routerPrefixes[routerName] || "";
          const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL);
          entryPoint.filePath = relativeFile;
          entryPoint.functionName = funcName;
          entryPoint.attribute = "HTTP";

          entryPoints.push(entryPoint);
          
        if (entryPointAndSourceAtSameTime) {
            const paramSources = findSourceOfFuncParam(relativeFile, funcName, obj, null);

          if (filename !== relativeFile) {
              const extra = findSourceOfFuncParam(filename, funcName, obj, null);
              if (extra?.length) entryPointSources.push(...extra);
          }

          if (paramSources) {
              for (const s of paramSources) s.scopeFile = "all";
              entryPointSources.push(...paramSources);
            }

            if (params.length && Array.isArray(obj.parameters)) {
              for (const p of obj.parameters) {
                const pn = p.id?.name;
                if (pn && params.includes(pn)) {
                entryPointSources.push({
                  introPoint: 4,
                    kind: "PYTHON_INPUT",
                    path: pn,
                    scopeFile: "all",
                  scopeFunc: funcName,
                    locStart: p.loc?.start?.line,
                    locEnd: p.loc?.end?.line,
                    locColumnStart: p.loc?.start?.column,
                    locColumnEnd: p.loc?.end?.column,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    fastApiEntryPointArray: entryPoints,
    fastApiEntryPointSourceArray: entryPointSources,
  };
}

export = { findFastApiEntryPointAndSource };

