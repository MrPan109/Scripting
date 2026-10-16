import { Intent, Navigation, Script } from "scripting"
import WatermarkApp from "./app"

/**
 * 快捷指令 / 分享面板入口。
 * 只负责把输入交给合并后的页面 —— 由它自己判断是小红书/抖音作品还是网页。
 */
function intentInput(): string {
  if (Intent.urlsParameter?.[0]) return Intent.urlsParameter[0]
  if (Intent.textsParameter?.[0]) return Intent.textsParameter[0]
  const parameter = Intent.shortcutParameter
  if (parameter?.type === "text") return String(parameter.value)
  if (parameter?.type === "fileURL") return String(parameter.value)
  return ""
}

async function run() {
  const queryURL = typeof Script.queryParameters?.url === "string" ? Script.queryParameters.url : ""
  const candidate = intentInput().trim() || queryURL

  await Navigation.present({ element: <WatermarkApp initialInput={candidate} autoParse={Boolean(candidate)} /> })
  Script.exit()
}

run()
