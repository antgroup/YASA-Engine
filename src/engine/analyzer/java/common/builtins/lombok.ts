const logger = require('../../../../../util/logger')(__filename)

module.exports = {
  /**
   * require processing for commonJS module
   * @param fname
   * @param fieldName
   */
  processGetter(fname: any, fieldName: any) {
    return function getter(fclos: any, argvalues: any, state: any, node: any, scope: any) {
      if (argvalues.length !== 0) {
        logger.warn('getter: params length [%d] is not equal to 0', argvalues.length)
      }
      return fclos.getThis().getFieldValue(fieldName, true)
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
      if (argvalues.length !== 1) {
        logger.warn('setter: params length [%d] is not equal to 1', argvalues.length)
      }
      fclos.getThis().setFieldValue(fieldName, argvalues[0])
      return fclos.getThis()
    }
  },
}
