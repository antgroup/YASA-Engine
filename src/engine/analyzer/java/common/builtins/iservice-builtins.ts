const { addElementToBuffer, getAllElementFromBuffer, collectDeepTaintDonors } = require('./buffer')
const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')

/**
 * com.baomidou.mybatisplus.extension.service.IService
 * MyBatis-Plus Service 层接口，ServiceImpl 为默认实现。
 * 建模核心：让 taint 从 Wrapper/Entity 参数传递到返回值，不丢失污点链路。
 */
class IService {
  /**
   * 根据条件查询单条记录
   * getOne(Wrapper) / getOne(Wrapper, boolean)
   * Wrapper buffer 中的 taint 传播到返回值
   */
  static getOne(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (argvalues.length >= 1 && argvalues[0]) {
      addElementToBuffer(_this, argvalues[0])
    }
    return _this
  }

  /**
   * 查询列表
   * list(Wrapper) / list()
   */
  static list(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (argvalues.length >= 1 && argvalues[0]) {
      addElementToBuffer(_this, argvalues[0])
    }
    return _this
  }

  /**
   * 分页查询
   * page(IPage, Wrapper)
   */
  static page(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (argvalues.length >= 1 && argvalues[0]) {
      addElementToBuffer(_this, argvalues[0])
    }
    if (argvalues.length >= 2 && argvalues[1]) {
      addElementToBuffer(_this, argvalues[1])
    }
    return _this
  }

  /**
   * 根据 ID 查询
   * getById(Serializable)
   */
  static getById(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (argvalues.length >= 1 && argvalues[0]) {
      addElementToBuffer(_this, argvalues[0])
    }
    return _this
  }

  /**
   * 统计数量
   * count(Wrapper) / count()
   */
  static count(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (argvalues.length >= 1 && argvalues[0]) {
      addElementToBuffer(_this, argvalues[0])
    }
    return _this
  }

  /**
   * 根据 ID 更新
   * updateById(Entity)
   */
  static updateById(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (argvalues.length >= 1 && argvalues[0]) {
      addElementToBuffer(_this, argvalues[0])
    }
    return _this
  }

  /**
   * 新增
   * save(Entity)
   */
  static save(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (argvalues.length >= 1 && argvalues[0]) {
      addElementToBuffer(_this, argvalues[0])
    }
    return _this
  }

  /**
   * 批量新增
   * saveBatch(Collection)
   */
  static saveBatch(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (argvalues.length >= 1 && argvalues[0]) {
      addElementToBuffer(_this, argvalues[0])
    }
    return _this
  }

  /**
   * 根据 ID 删除
   * removeById(Serializable)
   */
  static removeById(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (argvalues.length >= 1 && argvalues[0]) {
      addElementToBuffer(_this, argvalues[0])
    }
    return _this
  }

  /**
   * 根据 Wrapper 更新
   * update(Wrapper)
   */
  static update(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (argvalues.length >= 1 && argvalues[0]) {
      addElementToBuffer(_this, argvalues[0])
    }
    if (argvalues.length >= 2 && argvalues[1]) {
      addElementToBuffer(_this, argvalues[1])
    }
    return _this
  }
}

module.exports = IService