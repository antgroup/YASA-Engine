/**
 * 子进程脚本：在独立进程中解析文件（只做原始 parse，不含 processAst）
 * 子进程退出后 OS 立即回收内存，解决 worker_threads 共享 RSS 不释放问题
 */

// 类型定义
interface ParseTask {
  filepath: string
  content: string
  language: string
  options: Record<string, any>
  config: {
    unit: string
    needsSourcefile?: boolean
    maindirPrefix?: string
  }
}

interface WorkerMessage {
  type: 'parse'
  task: ParseTask
  taskId: number
}

interface WorkerResponse {
  taskId: number
  success: boolean
  result?: any
  error?: string
  workTime?: number
  messageTime?: number
}

const { parseFile: parseFileCore } = require('./parser-core')
const config = require('../../config')

/**
 * 原地删除 AST 所有节点的 parent 属性，避免 IPC JSON 序列化循环引用
 */
function deleteParent(node: any, visited = new Set()): void {
  if (!node || typeof node !== 'object' || visited.has(node)) return
  visited.add(node)
  delete node.parent
  for (const key of Object.keys(node)) {
    deleteParent(node[key], visited)
  }
}

/**
 * 处理解析任务（完整 parse + processAst，发送前删掉 parent 避免循环引用）
 */
async function processParseTask(task: ParseTask): Promise<{ filepath: string; ast: any; error?: string }> {
  if (task.config.maindirPrefix !== undefined) {
    config.maindirPrefix = task.config.maindirPrefix
  }
  try {
    const result = parseFileCore(task.filepath, task.content, task.language, task.options, task.config)
    deleteParent(result.ast)
    return result
  } catch (error) {
    return {
      filepath: task.filepath,
      ast: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// 主进程断开 IPC 时立即退出，防止子进程泄漏
process.on('disconnect', () => process.exit(0))

// 监听主进程消息
process.on('message', async (message: WorkerMessage) => {
  const messageReceiveTime = Date.now()
  let messageSendTime = 0
  let workStartTime = 0
  let workEndTime = 0

  try {
    let result

    if (message.type === 'parse') {
      workStartTime = Date.now()
      result = await processParseTask(message.task)
      workEndTime = Date.now()
    } else {
      throw new Error(`Unknown message type: ${message.type}`)
    }

    messageSendTime = Date.now()
    const workTime = workEndTime - workStartTime
    const messageTime = messageSendTime - messageReceiveTime
    const validatedWorkTime = workTime > 0 && workTime < 10000 ? workTime : 1

    process.send!({
      taskId: message.taskId,
      success: true,
      result,
      workTime: validatedWorkTime,
      messageTime,
    } as WorkerResponse)
  } catch (error) {
    messageSendTime = Date.now()
    const messageTime = messageSendTime - messageReceiveTime

    process.send!({
      taskId: message.taskId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      messageTime,
    } as WorkerResponse)
  }
})
