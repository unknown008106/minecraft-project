// Minimal RCON client (the Source RCON protocol Minecraft uses), enough to run server commands.

const net = require('net')

const AUTH = 3
const EXEC = 2

class Rcon {
  constructor (host, port, password) {
    this.host = host
    this.port = port
    this.password = password
    this.nextId = 1
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
    // Minecraft's RCON server reads one packet per network read and drops the rest,
    // so commands must go one at a time, each waiting for the previous reply
    this.chain = Promise.resolve()
  }

  connect () {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(this.port, this.host)
      this.socket.on('data', data => this.onData(data))
      this.socket.on('error', reject)
      this.socket.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('RCON connection closed by the server'))
        this.pending.clear()
      })
      this.socket.on('connect', () => {
        this.request(AUTH, this.password).then(resolve, reject)
      })
    })
  }

  onData (data) {
    this.buffer = Buffer.concat([this.buffer, data])
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0)
      if (this.buffer.length < 4 + length) return
      const id = this.buffer.readInt32LE(4)
      const body = this.buffer.toString('utf8', 12, 4 + length - 2)
      this.buffer = this.buffer.subarray(4 + length)
      if (id === -1) {
        for (const p of this.pending.values()) p.reject(new Error('RCON password rejected'))
        this.pending.clear()
        continue
      }
      const p = this.pending.get(id)
      if (p) {
        this.pending.delete(id)
        p.resolve(body)
      }
    }
  }

  request (type, body) {
    const id = this.nextId++
    const payload = Buffer.from(body, 'utf8')
    const packet = Buffer.alloc(14 + payload.length)
    packet.writeInt32LE(10 + payload.length, 0)
    packet.writeInt32LE(id, 4)
    packet.writeInt32LE(type, 8)
    payload.copy(packet, 12)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.write(packet)
    })
  }

  // Runs one server command (no leading slash) and returns the server's reply text.
  send (command) {
    const result = this.chain.then(() => this.request(EXEC, command))
    this.chain = result.catch(() => {})
    return result
  }

  close () {
    this.socket?.end()
  }
}

module.exports = { Rcon }
