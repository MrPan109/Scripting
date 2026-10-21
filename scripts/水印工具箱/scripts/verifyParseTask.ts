import { Script } from "scripting"
import {
  beginParseTask, invalidateParseTask, isCurrentParseTask, taskState,
  resources, pageTitle, statusText, filterProgress, isLoading,
} from "../state/appState"

// 仅使用内存状态与受控 Promise，不调用解析器、网络或定时器。
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let checks = 0
function assert(condition: boolean, label: string) {
  if (!condition) throw new Error(`FAIL: ${label}`)
  checks++
}
function view(task: number) {
  return {
    resources: taskState(resources, task), title: taskState(pageTitle, task),
    error: taskState(statusText, task), progress: taskState(filterProgress, task),
    loading: taskState(isLoading, task),
  }
}
function snapshot() {
  return JSON.stringify({ resources: resources.value, title: pageTitle.value,
    error: statusText.value, progress: filterProgress.value, loading: isLoading.value })
}
async function scenario(failA: boolean) {
  const taskA = beginParseTask()
  const a = view(taskA)
  const gateA = deferred()
  let aSettled = false
  const slow = (async () => {
    try {
      await gateA.promise
      a.resources.setValue([{ type: "image", url: "https://example.invalid/A.png", name: "A.png" }])
      a.title.setValue("A title")
    } catch {
      a.error.setValue("A error")
    } finally {
      a.progress.setValue({ completed: 1, total: 1 })
      a.loading.setValue(false)
      aSettled = true
    }
  })()

  const taskB = beginParseTask()
  const b = view(taskB)
  const gateB = deferred()
  const fast = (async () => {
    await gateB.promise
    b.resources.setValue([{ type: "image", url: "https://example.invalid/B.webp", name: "B.webp" }])
    b.title.setValue("B title")
    b.error.setValue("B status")
    b.progress.setValue({ completed: 2, total: 3 })
    // B 已提交结果，但仍有后续阶段：可检测 A 的 finally 提前关闭加载。
    b.loading.setValue(true)
  })()
  gateB.resolve()
  await fast
  assert(!aSettled, "B 提交时 A 仍未完成")
  assert(resources.value[0]?.name === "B.webp", "当前任务可以写入资源")
  assert(pageTitle.value === "B title", "当前任务可以写入标题")
  const expected = snapshot()
  invalidateParseTask(taskA)
  assert(isCurrentParseTask(taskB), "invalidate 旧任务不使 B 失效")
  assert(snapshot() === expected, "invalidate 旧任务不重置 B 状态")
  if (failA) gateA.reject(new Error("controlled A failure"))
  else gateA.resolve()
  await slow
  assert(resources.value[0]?.name === "B.webp", "旧资源不覆盖 B")
  assert(pageTitle.value === "B title", "旧标题不覆盖 B")
  assert(statusText.value === "B status", "旧异常不覆盖 B 状态")
  assert(filterProgress.value.completed === 2 && filterProgress.value.total === 3, "旧进度不覆盖 B")
  assert(isLoading.value === true, "旧 finally 不关闭 B 加载")
  assert(snapshot() === expected, "A 完成后 B 状态完整保留")
  b.loading.setValue(false)
  assert(isLoading.value === false, "B 自身可以结束加载")
  invalidateParseTask(taskB)
  assert(!isCurrentParseTask(taskB), "当前任务可主动失效")
  b.title.setValue("invalidated B")
  assert(pageTitle.value === "B title", "已失效任务不能再提交")
  console.log(`PASS: A ${failA ? "reject" : "resolve"}, B first`)
}

async function main() {
  await scenario(false)
  await scenario(true)
  console.log(`PASS: ${checks} assertions; controlled Promises; no network, no sleep`)
  Script.exit({ passed: true, assertions: checks })
}
void main().catch(error => {
  console.error(String(error))
  Script.exit({ passed: false, error: String(error) })
})
