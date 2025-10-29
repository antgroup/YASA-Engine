export {}
/**
 * move exist elements to buffer
 * @param _this
 * @param startIndex
 */
function moveExistElementsToBuffer(_this: any, startIndex?: number): void {
  if (!_this.getMisc('buffer')) {
    _this.setMisc('buffer', [])
  }
  if (_this.value) {
    for (const key in _this.value) {
      if (Number(key) >= 0) {
        if (!startIndex || (typeof startIndex === 'number' && Number(key) >= startIndex)) {
          _this.getMisc('buffer').push(_this.value[key])
        }
        delete _this.value[key]
      }
    }
  }
  _this.length = 0
}

/**
 * add single object to buffer
 * @param _this
 * @param object
 */
function addElementToBuffer(_this: any, object: any): void {
  if (!object) {
    return
  }
  if (!_this.getMisc('buffer')) {
    _this.setMisc('buffer', [])
  }
  _this.getMisc('buffer').push(object)
}

/**
 * clear buffer
 * @param _this
 */
function clearBuffer(_this: any): void {
  _this.setMisc('buffer', [])
}

/**
 * remove element from buffer
 * @param _this
 * @param element
 */
function removeElementFromBuffer(_this: any, element: any): void {
  if (!_this.getMisc('buffer')) {
    return
  }
  const tmpBuffer: any[] = []
  for (const bufferElement of _this.getMisc('buffer')) {
    if (bufferElement?._qid !== element?._qid) {
      tmpBuffer.push(bufferElement)
    }
  }
  _this.setMisc('buffer', tmpBuffer)
}

/**
 * get all element from buffer
 * @param _this
 */
function getAllElementFromBuffer(_this: any): any[] {
  const result: any[] = []
  if (!_this || !_this.getMisc('buffer')) {
    return result
  }
  for (const element of _this.getMisc('buffer')) {
    result.push(element)
  }

  return result
}

module.exports = {
  moveExistElementsToBuffer,
  addElementToBuffer,
  clearBuffer,
  removeElementFromBuffer,
  getAllElementFromBuffer,
}
