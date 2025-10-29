const { Parser: UastParser, LanguageType } = require('@ant-yasa/uast-parser-java-js')
const { handleException } = require('../../analyzer/common/exception-handler')

interface ParseOptions {
  language?: string
  [key: string]: any
}

const uastParser = new UastParser()

/**
 *
 * @param code
 * @param options
 */
function parseJava(code: string, options?: ParseOptions) {
  options = options || {}
  if (options.language && options.language !== LanguageType.LANG_JAVA && options.language !== 'java') {
    handleException(
      new Error(`Java AST Builder received wrong language type: ${options.language}`),
      `Error: Java AST Builder received wrong language type: ${options.language}`,
      `Error: Java AST Builder received wrong language type: ${options.language}`
    )
    process.exit(1)
  }
  options.language = LanguageType.LANG_JAVA
  return uastParser.parse(code, options)
}

// class Environment {
//     parent;
//     scope;
//
//     constructor(parent) {
//         this.parent = parent;
//         this.scope = new Map();
//     }
//
//     resolveName(name) {
//         return this.scope.get(name) || this.parent?.resolveName(name);
//     }
//
//     setName(name, node) {
//         this.scope.set(name, node);
//     }
// }
//
// function adjust(node, env) {
//     if (!node) return;
//     if (Array.isArray(node)) {
//         return node.map(n => adjust(n));
//     }
//     if (!node.type) return;
//     switch (node.type) {
//         case 'CompileUnit':
//             adjust(node.body);
//             break;
//         case 'ClassDefinition':
//             adjust(node.body);
//             break;
//         case 'FunctionDefinition': {
//             const newEnv = new Environment(env);
//             adjust(node.parameters, newEnv);
//             adjust(node.body, newEnv);
//             break;
//         }
//         case 'VariableDeclaration': {
//             env.setName(node.id.name, node);
//             break;
//         }
//         case 'MemberAccess': {
//             const obj = node.object;
//             if (obj.type === 'Identifier') {
//                 const n = env.resolveName(obj.name);
//                 if (!n) {
//                     n.object = UastSpec.memberAccess(UastSpec.thisExpression(), obj, false);
//                 }
//             }
//         }
//         case 'Identifier': {
//             if (env.resolveName(node.name)) {
//                 const prop = _.clone(node);
//                 node.type = 'MemberAccess';
//                 node.object = UAST.thisExpression();
//                 node.object.loc = node.loc;
//                 node.property = prop;
//             }
//             break;
//         }
//         case 'ScopedStatement': {
//             adjust(node.body, new Environment(env));
//             break;
//         }
//         default: {
//             for (const prop in node) {
//                 adjust(node[prop], env);
//             }
//         }
//     }
//
//     return node;
// }

module.exports = {
  parse: parseJava,
}
