import { Navigation, Script } from "scripting"
import WatermarkApp from "./app"
import { getActiveDownloadCount } from "./state/downloadManager"

// 供 intent.tsx 复用
export { WatermarkApp }

let isPresenting = false

/**
 * 展示主界面；关闭后如果还有正在下载的任务就保持实例存活（沿用网页资源提取器
 * 原来的后台下载体验），否则结束实例释放资源。
 */
async function presentApp(initialInput = "", autoParse = false): Promise<void> {
  if (isPresenting) return
  isPresenting = true
  try {
    await Navigation.present({ element: <WatermarkApp initialInput={initialInput} autoParse={autoParse} /> })
  } finally {
    isPresenting = false
  }

  if (getActiveDownloadCount() > 0 && Script.supportsMinimization()) {
    await Script.minimize()
    return
  }
  Script.exit()
}

// 从后台恢复（最小化后再打开、小组件/通知唤起）：回到下载管理器
Script.onResume(() => {
  void presentApp()
})

async function run() {
  const parameters = Script.queryParameters ?? {}
  const urlParameter = typeof parameters.url === "string" ? parameters.url : ""
  const inputParameter = typeof parameters.input === "string" ? parameters.input : ""
  const autoParse = parameters.auto === "1"

  // 来自 Safari 浏览器脚本 / 分享 / 小组件：统一交给合并后的页面自动分流
  const candidate = urlParameter || inputParameter
  await presentApp(candidate, Boolean(candidate) || autoParse)
}

run()
