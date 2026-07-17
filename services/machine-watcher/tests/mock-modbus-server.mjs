import net from 'node:net'

const registers = new Map()
const acceptedFunction = Number(process.env.MOCK_MODBUS_FUNCTION || 3)
const acceptedUnit = Number(process.env.MOCK_MODBUS_UNIT || 1)

function setUInt16(address, value) {
  registers.set(address, value & 0xffff)
}

function setInt32(address, value) {
  const bytes = Buffer.alloc(4)
  bytes.writeInt32BE(value)
  setBuffer(address, bytes)
}

function setFloat64(address, value) {
  const bytes = Buffer.alloc(8)
  bytes.writeDoubleBE(value)
  setBuffer(address, bytes)
}

function setBuffer(address, bytes) {
  for (let offset = 0; offset < bytes.length; offset += 2) {
    registers.set(address + (offset / 2), bytes.readUInt16BE(offset))
  }
}

setUInt16(100, 1)
setUInt16(101, 0)
const startedAt = Date.now()
setFloat64(110, 3_723_000)
setFloat64(114, 1_800_500)
setFloat64(118, 123_456_789)
setInt32(130, 17)
setInt32(132, 412)
setInt32(134, 50)

const server = net.createServer((socket) => {
  let pending = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 12) {
      const frameLength = 6 + pending.readUInt16BE(4)
      if (pending.length < frameLength) return
      const frame = pending.subarray(0, frameLength)
      pending = pending.subarray(frameLength)
      const transaction = frame.readUInt16BE(0)
      const unit = frame[6]
      const fn = frame[7]
      const address = frame.readUInt16BE(8)
      const quantity = frame.readUInt16BE(10)
      const elapsed = Date.now() - startedAt
      setFloat64(110, 3_723_000 + elapsed)
      setFloat64(114, 1_800_500 + elapsed)
      setFloat64(118, 123_456_789 + elapsed)
      if (fn !== acceptedFunction || unit !== acceptedUnit || quantity < 1 || quantity > 125) {
        socket.write(Buffer.from([
          transaction >> 8, transaction & 0xff, 0, 0, 0, 3, unit, fn | 0x80, 3,
        ]))
        continue
      }
      const data = Buffer.alloc(quantity * 2)
      for (let index = 0; index < quantity; index++) {
        data.writeUInt16BE(registers.get(address + index) ?? 0, index * 2)
      }
      const overlays = [
        [33564, 4, (buffer, offset) => buffer.writeDoubleBE(3_723_000 + elapsed, offset)],
        [33565, 4, (buffer, offset) => buffer.writeDoubleBE(1_800_500 + elapsed, offset)],
        [33868, 4, (buffer, offset) => buffer.writeDoubleBE(123_456_789 + elapsed, offset)],
        [33869, 2, (buffer, offset) => buffer.writeInt32BE(17, offset)],
        [33870, 2, (buffer, offset) => buffer.writeInt32BE(412, offset)],
        [33871, 2, (buffer, offset) => buffer.writeInt32BE(50, offset)],
      ]
      for (const [macro, words, writer] of overlays) {
        if (address <= macro && macro + words <= address + quantity) {
          writer(data, (macro - address) * 2)
        }
      }
      const response = Buffer.alloc(9 + data.length)
      response.writeUInt16BE(transaction, 0)
      response.writeUInt16BE(0, 2)
      response.writeUInt16BE(3 + data.length, 4)
      response[6] = unit
      response[7] = fn
      response[8] = data.length
      data.copy(response, 9)
      socket.write(response)
    }
  })
})

const port = Number(process.env.MOCK_MODBUS_PORT || 15020)
server.listen(port, '127.0.0.1', () => process.stdout.write(`ready ${port}\n`))
process.on('SIGTERM', () => server.close())
