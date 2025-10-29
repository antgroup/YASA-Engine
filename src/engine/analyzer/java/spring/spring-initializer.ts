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
    topScope.beanMap = beanMap
    topScope.springServiceMap = springServiceMap
    topScope.springReferenceMap = springReferenceMap
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
              springServiceMap.set(interfaceName, {
                ref,
              })
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
