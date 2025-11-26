import { extractRelativePath } from "../../../../../util/file-util";
import * as Constant from "../../../../../util/constant";
import { EntryPoint } from "../../../common/entrypoint";

const config = require("../../../../../config");
const { entryPointAndSourceAtSameTime } = config;

const PythonEntrypointSource = require("../../common/entrypoint-collector/python-entrypoint-source");
const { findSourceOfFuncParam } = PythonEntrypointSource;

const EntryPointClass = require("../../../common/entrypoint");

interface ASTObject {
  body?: any[];

  [key: string]: any;
}

interface FilenameAstMap {
  [filename: string]: ASTObject;
}

interface ValidInstances {
  validFastApiInstances: Set<string>;
  validRouterInstances: Set<string>;
}

interface EntryPointResult {
  fastApiEntryPointArray: EntryPoint[];
  fastApiEntryPointSourceArray: any[];
}

const ROUTE_DECORATORS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "head",
  "route",
]);

/**
 *
 * @param node
 * @returns
 */
function extractLiteralString(node: any): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

/**
 *
 * @param route
 * @returns
 */
function extractRouteParams(route: string | null): string[] {
  if (!route) return [];
  const regex = /\{(.*?)\}/g;
  const params: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(route)) !== null) {
    const name = match[1].split(":").pop();
    if (name) params.push(name);
  }
  return params;
}

/**
 *
 * @param obj
 * @returns
 */
function extractVarNameAndInit(
  obj: any,
): { varName?: string; init?: any } | null {
  try {
    if (obj.type === "AssignmentExpression" && obj.operator === "=") {
      if (obj.left?.type === "Identifier") {
        return { varName: obj.left.name, init: obj.right };
      }
    }
  } catch (error) {}
  return null;
}

/**
 *
 * @param body
 * @returns
 */
function analyzeImports(body: any[]): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(body)) return map;

  for (const obj of body) {
    if (!obj || typeof obj !== "object") continue;

    if (
      obj.type === "VariableDeclaration" &&
      obj.init?.type === "ImportExpression"
    ) {
      const importExpr = obj.init;
      const localName = obj.id?.name;
      if (!localName) continue;

      const fromValue = extractLiteralString(importExpr.from);
      const importedName = importExpr.imported?.name; // Identifier

      if (fromValue) {
        // from ... import ...
        if (fromValue === "fastapi" || fromValue.startsWith("fastapi.")) {
          if (importedName) {
            // Map 'FastAPI' or 'APIRouter' to 'fastapi.FastAPI' / 'fastapi.APIRouter'
            //  (case: fastapi.applications)
            map.set(localName, `fastapi.${importedName}`);
          }
        }
      } else if (
        importedName === "fastapi" ||
        importedName === "fastapi.applications" ||
        importedName === "fastapi.routing" ||
        importedName?.startsWith("fastapi.")
      ) {
        // import fastapi or import fastapi.applications
        if (
          importedName === localName ||
          importedName.startsWith(`${localName}.`)
        ) {
          map.set(localName, localName);
        } else {
          map.set(localName, importedName);
        }
      }
    }
  }
  return map;
}

/**
 *
 * @param node
 * @param importMap
 * @returns
 */
function resolveCanonicalName(
  node: any,
  importMap: Map<string, string>,
): string | null {
  if (!node) return null;
  if (node.type === "Identifier") {
    return importMap.get(node.name) || null;
  }
  if (node.type === "MemberAccess") {
    const objectCanonical = resolveCanonicalName(node.object, importMap);
    const propertyName = node.property?.name;
    if (objectCanonical && propertyName) {
      return `${objectCanonical}.${propertyName}`;
    }
  }
  return null;
}

/**
 *
 * @param body
 * @param importMap
 * @returns
 */
function collectValidInstances(
  body: any[],
  importMap: Map<string, string>,
): ValidInstances {
  const validFastApiInstances = new Set<string>();
  const validRouterInstances = new Set<string>();

  for (const obj of body) {
    if (!obj || typeof obj !== "object") continue;

    // Only process AssignmentExpression
    if (obj.type === "AssignmentExpression" && obj.operator === "=") {
      const varInfo = extractVarNameAndInit(obj);
      if (!varInfo?.varName || !varInfo.init) continue;

      if (varInfo.init.type === "CallExpression") {
        const canonical = resolveCanonicalName(varInfo.init.callee, importMap);
        if (
          canonical === "fastapi.FastAPI" ||
          canonical === "fastapi.applications.FastAPI"
        ) {
          validFastApiInstances.add(varInfo.varName);
        } else if (
          canonical === "fastapi.APIRouter" ||
          canonical === "fastapi.routing.APIRouter"
        ) {
          validRouterInstances.add(varInfo.varName);
        }
      }
    }
  }
  return { validFastApiInstances, validRouterInstances };
}

/**
 *
 * @param deco
 * @param funcName
 * @param obj
 * @param relativeFile
 * @param filename
 * @param validInstances
 * @param entryPoints
 * @param entryPointSources
 */
function processDecorator(
  deco: any,
  funcName: string,
  obj: any,
  relativeFile: string,
  filename: string,
  validInstances: ValidInstances,
  entryPoints: EntryPoint[],
  entryPointSources: any[],
): void {
  if (!deco || deco.type !== "CallExpression") return;
  const { callee } = deco;

  if (!callee || callee.type !== "MemberAccess") return;

  const methodName = callee.property?.name;
  if (!methodName || !ROUTE_DECORATORS.has(methodName)) return;

  // Get router or app name
  let routerName = "";
  if (callee.object?.type === "Identifier") {
    routerName = callee.object.name;
  }

  // Validate router/app
  const { validFastApiInstances, validRouterInstances } = validInstances;
  const isValidRouter =
    validFastApiInstances.has(routerName) ||
    validRouterInstances.has(routerName);

  if (!isValidRouter) return;

  // Create entrypoint
  const routePath = extractLiteralString(deco.arguments?.[0]);
  const params = extractRouteParams(routePath);

  const entryPoint = new EntryPointClass(Constant.ENGIN_START_FUNCALL);
  entryPoint.filePath = relativeFile;
  entryPoint.functionName = funcName;
  entryPoint.attribute = "HTTP";

  entryPoints.push(entryPoint);

  if (entryPointAndSourceAtSameTime) {
    const paramSources = findSourceOfFuncParam(
      relativeFile,
      funcName,
      obj,
      undefined,
    );

    if (paramSources) {
      const allScopeSources = paramSources.map((s: any) => ({
        ...s,
        scopeFile: "all",
      }));
      entryPointSources.push(...allScopeSources);
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

/**
 *
 * @param filenameAstObj
 * @param dir
 * @returns
 */
function findFastApiEntryPointAndSource(
  filenameAstObj: FilenameAstMap,
  dir: string,
): EntryPointResult {
  const entryPoints: EntryPoint[] = [];
  const entryPointSources: any[] = [];

  for (const filename in filenameAstObj) {
    if (!Object.prototype.hasOwnProperty.call(filenameAstObj, filename))
      continue;
    const fileObj = filenameAstObj[filename];
    if (!fileObj?.body) continue;

    // Calculate relative path
    const { body } = fileObj;
    const relativeFile = filename.startsWith(dir)
      ? extractRelativePath(filename, dir)
      : filename;

    if (!relativeFile) continue;

    const importMap = analyzeImports(body);

    const validImports = new Set([
      "fastapi",
      "fastapi.FastAPI",
      "fastapi.APIRouter",
      "fastapi.applications",
      "fastapi.routing",
    ]);
    let hasFastApiImport = false;
    for (const val of importMap.values()) {
      if (validImports.has(val)) {
        hasFastApiImport = true;
        break;
      }
    }
    if (!hasFastApiImport) continue;

    const validInstances = collectValidInstances(body, importMap);

    for (const obj of body) {
      if (!obj || typeof obj !== "object") continue;

      if (
        obj.type === "FunctionDefinition" &&
        obj._meta?.decorators &&
        obj.id?.name
      ) {
        const funcName = obj.id.name;
        const { decorators } = obj._meta;

        for (const deco of decorators) {
          processDecorator(
            deco,
            funcName,
            obj,
            relativeFile,
            filename,
            validInstances,
            entryPoints,
            entryPointSources,
          );
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
