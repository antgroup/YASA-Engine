const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')

module.exports = {
  /**
   * require processing for commonJS module
   * @param fname
   * @param fieldName
   */
  processGetter(fname: any, fieldName: any) {
    return function getter(fclos: any, argvalues: any, state: any, node: any, scope: any) {
      const _this = fclos.getThisObj()
      if (!_this) {
        return new UndefinedValue()
      }
      const res = _this.getFieldValue(fieldName, true)
      if (res && typeof res === 'object' && res?.vtype !== 'fclos' && res?.vtype !== 'class' && ['symbol', 'object'].includes(_this.vtype)) {
        res.object = _this
        if (_this.taint?.isTaintedRec) {
          res.taint?.markSource()
        }
      }
      return res
    }
  },
  processSetter(fname: any, fieldName: any) {
    // TODO setter 有点问题，如
    // public void setSuccess(){
    //         this.setSuccess("S");
    //         this.setResultCode("00000000");
    //         this.setResultMsg("SUCCESS");
    //     }
    // 没有入参，会把符号值变为undefined
    return function setter(fclos: any, argvalues: any, state: any, node: any, scope: any) {
      const _this = fclos.getThisObj()
      if (!_this) {
        return new UndefinedValue()
      }
      if (_this.vtype === 'primitive') {
        return _this
      }
      _this.setFieldValue(fieldName, argvalues[0])
      return _this
    }
  },
  _CTOR_(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (_this.vtype === 'primitive' || !Array.isArray(argvalues)) {
      return _this
    }
    for (const argvalue of argvalues) {
      if (argvalue.sid) {
        _this.setFieldValue(argvalue.sid, argvalue)
      }
    }
    return _this
  },
}
