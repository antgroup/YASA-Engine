const logger = require('../../../../../util/logger')(__filename)

module.exports = {
  /**
   * require processing for commonJS module
   * @param fname
   * @param fieldName
   */
  processGetter(fname, fieldName) {
    return function getter(fclos, argvalues, state, node, scope) {
      if (argvalues.length !== 0) {
        logger.warn('getter: params length [%d] is not equal to 0', argvalues.length)
      }
      return fclos.getThis().getFieldValue(fieldName, true)
    }
  },
  processSetter(fname, fieldName) {
    // TODO setter 有点问题，如
    // public void setSuccess(){
    //         this.setSuccess("S");
    //         this.setResultCode("00000000");
    //         this.setResultMsg("SUCCESS");
    //     }
    // 没有入参，会把符号值变为undefined
    return function setter(fclos, argvalues, state, node, scope) {
      if (argvalues.length !== 1) {
        logger.warn('setter: params length [%d] is not equal to 1', argvalues.length)
      }
      fclos.getThis().setFieldValue(fieldName, argvalues[0])
      return fclos.getThis()
    }
  },
}
