import { PassThrough } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import SubprocessRuntime, {
  type SubprocessHandle,
  type SubprocessSpawnSpec,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

export default class FixtureSubprocess extends SubprocessRuntime {
  async resolveExecutable(command: string): Promise<string> { return command }

  spawn(_spec: SubprocessSpawnSpec): SubprocessHandle {
    const input = new PassThrough()
    const output = new PassThrough()
    const peer = new JsonRpcLineTransport(output, input)
    peer.onRequest((method) => {
      if (method === 'initialize') return Promise.resolve({})
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-1', ephemeral: true } })
      if (method === 'turn/start') {
        peer.notify('item/completed', {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'webSearch',
            id: 'search-1',
            query: 'loader query',
            action: null,
            results: [{ url: 'https://loader.example/result', title: 'Loader result' }],
          },
        })
        peer.notify('turn/completed', {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed' },
        })
        return Promise.resolve({ turn: { id: 'turn-1' } })
      }
      return Promise.reject(new Error('unexpected fixture method ' + method))
    })
    peer.start()
    const exit = Promise.withResolvers<{ exitCode: number; signal: null }>()
    return {
      pid: 42,
      stdin: output,
      stdout: input,
      stderr: new PassThrough(),
      collected: {},
      done: exit.promise,
      terminate: () => { exit.resolve({ exitCode: 0, signal: null }) },
      waitForExit: async () => { await exit.promise; return true },
    }
  }

  async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('terminal spawning is outside this fixture')
  }
}
