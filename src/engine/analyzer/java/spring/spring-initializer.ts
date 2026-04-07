const xml2js = require('xml2js')
const JavaInitializer = require('../common/java-initializer')
const FileUtil = require('../../../../util/file-util')
const { handleException } = require('../../common/exception-handler')

/**
 *
 */
class SpringInitializer extends (JavaInitializer as any) {
  static builtin = {
    ...super.builtin,
  }

  /**
   *
   * @param topScope
   * @param dir
   */
  static async initBeans(topScope: any, dir: any) {
    const beanMap = new Map()
    const springReferenceMap = new Map()
    const springServiceMap = new Map()
    /* SOFA 服务映射：unique-id → {ref, interfaceName}，interfaceName → [{uniqueId, ref}] */
    const sofaServiceUniqueIdMap: Map<string, {ref: string, interfaceName: string}> = new Map()
    const sofaServiceInterfaceMap: Map<string, Array<{uniqueId: string, ref: string}>> = new Map()
    topScope.spring = {
      beanMap,
      springReferenceMap,
      springServiceMap,
      sofaServiceUniqueIdMap,
      sofaServiceInterfaceMap,
    }
    const xmlFiles = FileUtil.loadAllFileTextGlobby(['**/*.xml'], dir)
    if (xmlFiles.length === 0) {
      return
    }

    for (const xmlFile of xmlFiles) {
      if (xmlFile.content.includes('<bean') || xmlFile.content.includes('<sofa:')) {
        try {
          // 创建 XML 解析器
          const parser = new xml2js.Parser({
            explicitArray: false,
            strict: false,
            tagNameProcessors: [
              (tagName: string) => tagName.toLowerCase(), // 将标签名转换为小写
            ],
          })

          // 解析 XML 数据
          const result = await parser.parseStringPromise(xmlFile.content)

          if (result == null) {
            return
          }

          // 提取信息
          const beans = result.beans?.bean
          const springServices = result.beans?.['sofa:service']
          const springReferences = result.beans?.['sofa:reference']

          if (beans) {
            const beanArray = Array.isArray(beans) ? beans : [beans]

            beanArray.forEach((bean: any) => {
              const id = bean.$?.ID || ''
              const className = bean.$?.CLASS || ''
              const initMethod = bean.$?.['INIT-METHOD'] || ''
              const factoryMethod = bean.$?.['FACTORY-METHOD'] || ''
              beanMap.set(id, {
                className,
                initMethodName: initMethod,
                factoryMethodName: factoryMethod,
              })
            })
          }

          if (springServices) {
            const springServiceArray = Array.isArray(springServices) ? springServices : [springServices]
            springServiceArray.forEach((springService: any) => {
              const ref = springService.$?.REF || ''
              const interfaceName = springService.$?.INTERFACE || ''
              const uniqueId = springService.$?.['UNIQUE-ID'] || ''
              springServiceMap.set(interfaceName, {
                ref,
              })
              /* 填充 SOFA unique-id 映射 */
              if (uniqueId) {
                sofaServiceUniqueIdMap.set(uniqueId, { ref, interfaceName })
              }
              if (interfaceName) {
                if (!sofaServiceInterfaceMap.has(interfaceName)) {
                  sofaServiceInterfaceMap.set(interfaceName, [])
                }
                sofaServiceInterfaceMap.get(interfaceName)!.push({ uniqueId, ref })
              }
            })
          }

          if (springReferences) {
            const springReferenceArray = Array.isArray(springReferences) ? springReferences : [springReferences]
            springReferenceArray.forEach((springReference: any) => {
              const id = springReference.$?.ID || ''
              const interfaceName = springReference.$?.INTERFACE || ''
              springReferenceMap.set(id, {
                interfaceName,
              })
            })
          }
        } catch (e) {
          handleException(
            e,
            'Error occurred in SpringInitializer.initBeans',
            'Error occurred in SpringInitializer.initBeans'
          )
        }
      }
    }
  }
}

export = SpringInitializer
