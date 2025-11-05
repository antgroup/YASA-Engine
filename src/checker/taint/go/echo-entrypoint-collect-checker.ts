const config = require("../../../config");

const RouteRegistryObject = ["github.com/labstack/echo/v4.New()"];
const IntroduceTaint = require("../common-kit/source-util");
const Checker = require("../../common/checker");
const { completeEntryPoint } = require("./entry-points-util");

const processedRouteRegistry = new Set();

class EchoEntrypointCollectChecker extends Checker {
    constructor(resultManager: any) {
        super(resultManager, "echo-entrypoint-collect-checker");
    }

    triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
        const { fclos, argvalues } = info;
        this.collectRouteRegistry(node, fclos, argvalues, scope, info);
    }

    triggerAtSymbolInterpretOfEntryPointAfter(analyzer: any, scope: any, node: any, state: any, info: any) {
        if (info?.entryPoint.functionName === "main") processedRouteRegistry.clear();
    }

    collectRouteRegistry(callExpNode: any, calleeFClos: any, argValues: any, scope: any, info: any) {
        const { analyzer, state } = info;
        if (config.entryPointMode === "ONLY_CUSTOM") return;
        if (!(calleeFClos && calleeFClos.object && calleeFClos.property)) return;
        const { object, property } = calleeFClos;
        if (!object._qid || !property.name) return;
        const objectQid = object._qid;
        if (!RouteRegistryObject.some((prefix) => objectQid.startsWith(prefix))) return;
        switch (property.name) {
            case "Use":
            case "Pre":
                this.handleUseOrPre(analyzer, scope, state, argValues);
                break;
            case "CONNECT":
            case "DELETE":
            case "GET":
            case "HEAD":
            case "OPTIONS":
            case "PATCH":
            case "POST":
            case "PUT":
            case "TRACE":
            case "RouteNotFound":
            case "Any":
                this.handleMethodRegistration(analyzer, scope, state, argValues);
                break;
            case "Match":
            case "Add":
                this.handleMatchOrAdd(analyzer, scope, state, argValues);
                break;
            case "File":
                this.handleFile(analyzer, scope, state, argValues);
                break;
            case "Host":
            case "Group":
                this.handleHostOrGroup(analyzer, scope, state, argValues);
                break;
        }
    }

    processEntryPointAndTaintSource(analyzer: any, state: any, entryPointFuncValue: any, source: string) {
        if (entryPointFuncValue?.vtype === "fclos" && entryPointFuncValue?.ast.loc) {
            const hash = JSON.stringify(entryPointFuncValue.ast.loc)
            if (!processedRouteRegistry.has(hash)) {
                processedRouteRegistry.add(hash)
                IntroduceTaint.introduceFuncArgTaintBySelfCollection(entryPointFuncValue, state, analyzer, source, 'GO_INPUT')
                const entryPoint = completeEntryPoint(entryPointFuncValue)
                analyzer.entryPoints.push(entryPoint)
            }
        }
    }

    handleMiddlewareFunctionValue(analyzer: any, scope: any, state: any, middlewareFunctionValue: any) {
        const retVal = analyzer.processAndCallFuncDef(scope, middlewareFunctionValue.fdef, middlewareFunctionValue, state)
        let handlerFuncValues
        switch (retVal.vtype) {
            case "union":
                handlerFuncValues = retVal.value
                break;
            default: // "fclos"
                handlerFuncValues = [retVal]
                break;
        }
        handlerFuncValues.forEach((handlerFuncValue: any) => {
            this.processEntryPointAndTaintSource(analyzer, state, handlerFuncValue, '0')
        })
    }

    handleUseOrPre(analyzer: any, scope: any, state: any, argValues: any) {
        const middlewareFunctionValues = argValues.filter((argValue: any) => argValue.vtype === "fclos")
        middlewareFunctionValues.forEach((middlewareFunctionValue: any) => {
            this.handleMiddlewareFunctionValue(analyzer, scope, state, middlewareFunctionValue)
        })
    }

    handleMethodRegistration(analyzer: any, scope: any, state: any, argValues: any) {
        this.processEntryPointAndTaintSource(analyzer, state, argValues[1], '0')

        for (let i = 2; i < argValues.length; i++) {
            const argValue = argValues[i]
            if (argValue.vtype === "fclos") {
                const middlewareFunctionValue = argValue
                this.handleMiddlewareFunctionValue(analyzer, scope, state, middlewareFunctionValue)
            }
        }
    }

    handleMatchOrAdd(analyzer: any, scope: any, state: any, argValues: any) {
        this.processEntryPointAndTaintSource(analyzer, state, argValues[2], '0')

        for (let i = 3; i < argValues.length; i++) {
            const argValue = argValues[i]
            if (argValue.vtype === "fclos") {
                const middlewareFunctionValue = argValue
                this.handleMiddlewareFunctionValue(analyzer, scope, state, middlewareFunctionValue)
            }
        }
    }

    handleFile(analyzer: any, scope: any, state: any, argValues: any) {
        for (let i = 2; i < argValues.length; i++) {
            const argValue = argValues[i]
            if (argValue.vtype === "fclos") {
                const middlewareFunctionValue = argValue
                this.handleMiddlewareFunctionValue(analyzer, scope, state, middlewareFunctionValue)
            }
        }
    }

    handleHostOrGroup(analyzer: any, scope: any, state: any, argValues: any) {
        for (let i = 1; i < argValues.length; i++) {
            const argValue = argValues[i]
            if (argValue.vtype === "fclos") {
                const middlewareFunctionValue = argValue
                this.handleMiddlewareFunctionValue(analyzer, scope, state, middlewareFunctionValue)
            }
        }
    }
}

module.exports = EchoEntrypointCollectChecker