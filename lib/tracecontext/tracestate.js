/**
 * Class for Managing Tracestate
 *
 * Class that creates objects for managing trace state.
 * This class is capable of parsing both tracestate strings
 * and tracestate binary representations, allowing clients
 * to get and set values in a single list-member/namespace
 * while preserving values in the other namespaces.
 *
 * Capable of working with either the binary of string
 * formatted tracestate values.
 *
 * Usage:
 *   const tracestate = TraceState.fromStringFormatString(headerTracestate, 'es')
 *   tracestate.setValue('s',1)
 *   const newHeader = tracestate.toW3cString()
 */
class TraceState {
  constructor (sourceBuffer, listMemberNamespace = 'es', defaultValues = {}, logger) {
    if (!this._validateVendorKey(listMemberNamespace)) {
      throw new Error('Vendor namespace failed validation.')
    }

    // buffer representation of the other vendor namespace
    this.buffer = sourceBuffer

    // values for our namespace
    this.values = defaultValues

    this.listMemberNamespace = listMemberNamespace

    // if no logger, then fallback to agent singleton
    logger = logger || require('../..').logger
    this.logger = logger
  }

  setValue (key, value) {
    const strKey = String(key)
    const strValue = String(value)
    if (!this._validateElasicKeyAndValue(strKey, strValue)) {
      this.logger.trace('could not set tracestate key, invaliad characters detected')
      return false
    }

    const oldValue = this.values[strKey]
    this.values[strKey] = value

    // if new length is greater than 256, undo the setting
    const serializedValue = this._serializeValues(this.values)
    if (serializedValue.length > 256 && (typeof oldValue === 'undefined')) {
      delete this.values[strKey]
    }
    if (serializedValue.length > 256 && (typeof oldValue !== 'undefined')) {
      this.values[strKey] = oldValue
    }

    return true
  }

  getValue (keyToGet) {
    const allValues = this.toJson()
    const rawValue = allValues[this.listMemberNamespace]
    const values = TraceState._parseValues(rawValue)
    return values[keyToGet]
  }

  toHexString () {
    const newBuffer = Buffer.alloc(this.buffer.length)
    let newBufferOffset = 0
    for (let i = 0; i < this.buffer.length; i++) {
      const byte = this.buffer[i]
      if (byte === 0) {
        const indexOfKeyLength = i + 1
        const indexOfKey = i + 2
        const lengthKey = this.buffer[indexOfKeyLength]

        const indexOfValueLength = indexOfKey + lengthKey
        const indexOfValue = indexOfValueLength + 1
        const lengthValue = this.buffer[indexOfValueLength]

        const key = this.buffer.slice(indexOfKey, indexOfKey + lengthKey).toString()
        // bail out if this is our mutable namespace
        if (key === this.listMemberNamespace) { continue }

        // if this is not our key copy from the `0` byte to the end of the value
        this.buffer.copy(newBuffer, newBufferOffset, i, indexOfValue + lengthValue)
        newBufferOffset += (indexOfValue + lengthValue)

        // skip ahead to first byte after end of value
        i = indexOfValue + lengthValue - 1
        continue
      }
    }

    // now serialize the internal representation
    const ourBytes = []
    if (Object.keys(this.values).length > 0) {
      // the zero byte
      ourBytes.push(0)

      // the length of the vendor namespace
      ourBytes.push(this.listMemberNamespace.length)
      // the chars of the vendor namespace
      for (let i = 0; i < this.listMemberNamespace.length; i++) {
        ourBytes.push(this.listMemberNamespace.charCodeAt(i))
      }

      // add the length of the value
      const serializedValue = this._serializeValues(this.values)
      ourBytes.push(serializedValue.length)

      // add the bytes of the value
      for (let i = 0; i < serializedValue.length; i++) {
        ourBytes.push(serializedValue.charCodeAt(i))
      }
    }
    const ourBuffer = Buffer.from(ourBytes)
    return Buffer.concat(
      [newBuffer, ourBuffer],
      newBuffer.length + ourBuffer.length
    ).toString('hex')
  }

  /**
   * Returns JSON reprenstation of tracestate key/value pairs
   *
   * Does not parse the mutable list namespace
   */
  toJson () {
    const json = {}

    for (let i = 0; i < this.buffer.length; i++) {
      const byte = this.buffer[i]
      if (byte === 0) {
        const indexOfKeyLength = i + 1
        const indexOfKey = i + 2
        const lengthKey = this.buffer[indexOfKeyLength]

        const indexOfValueLength = indexOfKey + lengthKey
        const indexOfValue = indexOfValueLength + 1
        const lengthValue = this.buffer[indexOfValueLength]

        const key = this.buffer.slice(indexOfKey, indexOfKey + lengthKey).toString()
        const value = this.buffer.slice(indexOfValue, indexOfValue + lengthValue).toString()

        json[key] = value

        // skip ahead
        i = indexOfValue + lengthValue - 1
        continue
      }
    }

    // then, serialize values from the internal representation. This means
    // we end up prefering values set in this.value over
    // values set in the initial buffer
    json[this.listMemberNamespace] = this._serializeValues(
      this.values
    )
    return json
  }

  toString () {
    return this.toW3cString()
  }

  toW3cString () {
    const json = this.toJson()
    const chars = []
    for (const [key, value] of Object.entries(json)) {
      if (!value) { continue }
      chars.push(key)
      chars.push('=')
      chars.push(value)
      chars.push(',')
    }
    return chars.join('')
  }

  _serializeValues (string) {
    let mutableString = ''
    for (const [key, value] of Object.entries(string)) {
      mutableString += `${key}:${value};`
    }
    return mutableString
  }

  _validateVendorKey (key) {
    if (key.length > 256 || key.length < 1) {
      return false
    }

    const re = new RegExp(
      '^[abcdefghijklmnopqrstuvwxyz0123456789_\\-\\*/]*$'
    )
    if (!key.match(re)) {
      return false
    }
    return true
  }

  _validateElasicKeyAndValue (key, value) {
    // 0x20` to `0x7E WITHOUT `,` or `=` or `;` or `;`
    const re = /^[ \][!"#$%&'()*+\-./0123456789<>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ^_abcdefghijklmnopqrstuvwxyz{|}~]*$/

    if (!key.match(re) || !value.match(re)) {
      return false
    }

    if (key.length > 256 || value.length > 256) {
      return false
    }

    return true
  }

  static fromBinaryFormatHexString (string, listMemberNamespace = 'es') {
    const [buffer, values] =
      TraceState._removeMemberNamespaceFromBuffer(Buffer.from(string, 'hex'), listMemberNamespace)

    return new TraceState(buffer, listMemberNamespace, values)
  }

  static fromStringFormatString (string = '', listMemberNamespace = 'es') {
    // converts string format to byte format
    const bytes = []

    const parts = string.split(',')
    for (const [, part] of parts.entries()) {
      if (!part) { continue }
      const [listMember, value] = part.split('=')
      if (!listMember || !value) { continue }
      bytes.push(0)
      bytes.push(listMember.length)
      for (let i = 0; i < listMember.length; i++) {
        bytes.push(listMember.charCodeAt(i))
      }
      bytes.push(value.length)
      for (let i = 0; i < value.length; i++) {
        bytes.push(value.charCodeAt(i))
      }
    }

    const [buffer, values] =
      TraceState._removeMemberNamespaceFromBuffer(Buffer.from(bytes), listMemberNamespace)

    return new TraceState(buffer, listMemberNamespace, values)
  }

  static _parseValues (rawValues) {
    const parsedValues = {}
    for (const [, keyValue] of rawValues.split(';').entries()) {
      if (!keyValue) { continue }
      const [key, value] = keyValue.split(':')
      if (!key || !value) { continue }
      parsedValues[key] = value
    }
    return parsedValues
  }

  static _removeMemberNamespaceFromBuffer (buffer, listMemberNamespace) {
    const newBuffer = Buffer.alloc(buffer.length)
    let newBufferOffset = 0
    const values = {}
    for (let i = 0; i < buffer.length; i++) {
      const byte = buffer[i]
      if (byte === 0) {
        const indexOfKeyLength = i + 1
        const indexOfKey = i + 2
        const lengthKey = buffer[indexOfKeyLength]

        const indexOfValueLength = indexOfKey + lengthKey
        const indexOfValue = indexOfValueLength + 1
        const lengthValue = buffer[indexOfValueLength]

        const key = buffer.slice(indexOfKey, indexOfKey + lengthKey).toString()

        // if this is our mutable namespace extract
        // and set the value in vlaues, otherwise
        // copy into new buffer
        if (key === listMemberNamespace) {
          const rawValues = buffer.slice(indexOfValue, indexOfValue + lengthValue).toString()
          const parsedValues = TraceState._parseValues(rawValues)
          for (const [key, value] of Object.entries(parsedValues)) {
            values[key] = value
          }
          continue
        } else {
          buffer.copy(newBuffer, newBufferOffset, i, indexOfValue + lengthValue)
          newBufferOffset += (indexOfValue + lengthValue - i)
        }

        // skip ahead to first byte after end of value
        i = indexOfValue + lengthValue - 1
        continue
      }
    }

    // trim off extra 0 bytes
    const trimmedBuffer = newBuffer.slice(0, newBufferOffset)

    return [
      trimmedBuffer,
      values
    ]
  }
}

module.exports = TraceState
