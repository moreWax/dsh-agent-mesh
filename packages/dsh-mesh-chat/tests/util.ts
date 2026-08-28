import type { Server } from 'node:http'
export function listen(server: Server): Promise<string> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`)
  }))
}
