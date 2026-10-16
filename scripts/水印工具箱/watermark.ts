// 自定义水印模块。
//
// 文字排版交给 WebKit（WebView 里的 canvas），再把透明的文字 PNG 用 ffmpeg overlay 叠到原图上。
//
// 为什么不用 ffmpeg 的 drawtext：drawtext 只加载单个字体文件、没有字体回退，
// 只要有一个字符不在该字体里就会画成「豆腐块」（□）。实测三种字体都对
// 扩展A汉字（㟷）、扩展B汉字（𠮷）、emoji（🏛）缺字——这正是「水印最后一个字是框框」的原因。
// WebKit 则有完整的系统字体回退链，中文、生僻字、emoji、单位符号都能画对。
//
// 图片是单帧处理，很快（约 0.1–0.4 秒）；视频重新编码会卡死 shell，所以视频入口在 UI 上仍不开放。

export type WatermarkPosition = "bottomRight" | "bottomLeft" | "topRight" | "topLeft" | "center"
export type WatermarkMediaKind = "image" | "video"
export type WatermarkFont = "heiti" | "yuanti" | "mingchao"
export type WatermarkColorId = "white" | "black" | "yellow" | "orange" | "red" | "pink" | "blue" | "green"

export interface WatermarkColorOption {
  id: WatermarkColorId
  name: string
  /** 文字填充色（十六进制，同时给界面当色块用） */
  fill: `#${string}`
  /** 描边色：与填充形成对比，保证在任意底图上都看得清（只给 canvas 用，可为 rgba） */
  stroke: string
}

export const WATERMARK_COLORS: WatermarkColorOption[] = [
  { id: "white", name: "白", fill: "#FFFFFF", stroke: "rgba(0,0,0,0.72)" },
  { id: "black", name: "黑", fill: "#101010", stroke: "rgba(255,255,255,0.92)" },
  { id: "yellow", name: "黄", fill: "#FFD60A", stroke: "rgba(0,0,0,0.72)" },
  { id: "orange", name: "橙", fill: "#FF9F0A", stroke: "rgba(0,0,0,0.72)" },
  { id: "red", name: "红", fill: "#FF453A", stroke: "rgba(255,255,255,0.92)" },
  { id: "pink", name: "粉", fill: "#FF2D55", stroke: "rgba(255,255,255,0.92)" },
  { id: "blue", name: "蓝", fill: "#0A84FF", stroke: "rgba(255,255,255,0.92)" },
  { id: "green", name: "绿", fill: "#30D158", stroke: "rgba(0,0,0,0.72)" },
]

/** 可选字号：占画面宽度的百分比（换成具体像素见 fontSizeFor） */
export const SIZE_PERCENTS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20]

export const MIN_SIZE_PERCENT = 2
export const MAX_SIZE_PERCENT = 20

export interface WatermarkStyle {
  position: WatermarkPosition
  font: WatermarkFont
  /** 字号：画面宽度的百分比 */
  sizePercent: number
  color: WatermarkColorId
}

export const DEFAULT_STYLE: WatermarkStyle = { position: "bottomRight", font: "heiti", sizePercent: 6, color: "white" }

export function colorOption(id: WatermarkColorId): WatermarkColorOption {
  return WATERMARK_COLORS.find(option => option.id === id) ?? WATERMARK_COLORS[0]
}

/** 百分比字号 → 当前照片上的实际像素字号 */
export function fontSizeFor(imageWidth: number, sizePercent: number): number {
  const percent = Math.min(MAX_SIZE_PERCENT, Math.max(MIN_SIZE_PERCENT, sizePercent))
  return Math.max(8, Math.round((imageWidth * percent) / 100))
}

/**
 * WebKit 里的字体栈。实测可用：PingFang SC / Heiti SC（同一套中文字体）、
 * Hiragino Maru Gothic ProN、Hiragino Mincho ProN；末尾一律留 sans-serif，
 * 让系统回退字体兜住生僻字与 emoji。
 */
const FONT_STACKS: Record<WatermarkFont, string> = {
  heiti: `"PingFang SC", "Heiti SC", -apple-system, "Helvetica Neue", sans-serif`,
  yuanti: `"Hiragino Maru Gothic ProN", "PingFang SC", sans-serif`,
  mingchao: `"Hiragino Mincho ProN", "PingFang SC", sans-serif`,
}

// 水印离画面边缘的距离，按画面宽度比例给
const MARGIN_DIVISOR = 50

// 画布上限保护：超限时自动换行 / 缩小字号
const MAX_SIDE = 4096
const MAX_AREA = 8_000_000

type FrameSize = { width: number; height: number }
type TextTexture = { path: string; width: number; height: number; lines: number; fontSize: number }

function jsonLiteral(value: string): string {
  return JSON.stringify(value)
}

/** 原图像素尺寸：ffprobe 为主，失败时退回 UIImage */
async function frameSize(path: string): Promise<FrameSize> {
  try {
    const probe = await Shell.run(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${path}"`, { timeout: 30 })
    const dims = probe.output.trim().split("x").map(Number)
    if (dims[0] > 0 && dims[1] > 0) return { width: dims[0], height: dims[1] }
  } catch {}
  const image = UIImage.fromFile(path)
  if (image && image.width > 0 && image.height > 0) {
    const scale = image.scale > 0 ? image.scale : 1
    return { width: Math.round(image.width * scale), height: Math.round(image.height * scale) }
  }
  return { width: 1080, height: 1440 }
}

/** 供界面显示「当前照片宽多少像素→字号多少像素」 */
export async function imagePixelWidth(path: string): Promise<number> {
  return (await frameSize(path)).width
}

/** 在隐藏的 WebView 里用 canvas 排版文字，导出透明 PNG */
async function renderTextTexture(text: string, style: WatermarkStyle, pixelSize: number, frame: FrameSize): Promise<TextTexture> {
  const stack = FONT_STACKS[style.font]
  const color = colorOption(style.color)
  const margin = Math.max(24, Math.round(frame.width / MARGIN_DIVISOR))
  const script = `return (function () {
  var canvas = document.getElementById('c')
  var text = ${jsonLiteral(text)}
  var stack = ${jsonLiteral(stack)}
  var fillColor = ${jsonLiteral(color.fill)}
  var strokeColor = ${jsonLiteral(color.stroke)}
  var size = ${Math.max(8, Math.round(pixelSize))}
  var available = Math.max(64, Math.min(${frame.width} - ${margin} * 2, ${MAX_SIDE}))
  var maxSide = ${MAX_SIDE}
  var maxArea = ${MAX_AREA}

  function fontOf(value) { return '600 ' + value + 'px ' + stack }

  function wrapLines(ctx) {
    var chars = Array.from(text)
    var lines = []
    var current = ''
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i]
      current += ch
      if (current.length > ch.length && ctx.measureText(current).width > available) {
        var head = current.slice(0, current.length - ch.length)
        var space = head.lastIndexOf(' ')
        if (space > 0) {
          lines.push(head.slice(0, space))
          current = head.slice(space + 1) + ch
        } else {
          lines.push(head)
          current = ch
        }
      }
    }
    if (current.length > 0) lines.push(current)
    return lines.length > 0 ? lines : ['']
  }

  var lines = []
  var pad = 2
  var lineHeight = 0
  var width = 1
  var height = 1
  var attempts = 0
  while (true) {
    var ctx = canvas.getContext('2d')
    ctx.font = fontOf(size)
    lines = wrapLines(ctx)
    pad = Math.max(2, Math.round(size * 0.2))
    lineHeight = Math.max(1, Math.round(size * 1.28))
    var widest = 0
    for (var j = 0; j < lines.length; j++) {
      var measured = ctx.measureText(lines[j]).width
      if (measured > widest) widest = measured
    }
    width = Math.max(1, Math.ceil(widest) + pad * 2)
    height = Math.max(1, lines.length * lineHeight + pad * 2)
    if (size <= 8 || attempts >= 12) break
    if (width <= maxSide && height <= maxSide && width * height <= maxArea) break
    size = Math.max(8, Math.floor(size * 0.85))
    attempts += 1
  }

  canvas.width = width
  canvas.height = height
  var draw = canvas.getContext('2d')
  draw.font = fontOf(size)
  draw.textAlign = 'center'
  draw.textBaseline = 'middle'
  draw.lineJoin = 'round'
  draw.miterLimit = 2
  draw.lineWidth = Math.max(2, Math.round(size * 0.12))
  draw.strokeStyle = strokeColor
  draw.fillStyle = fillColor
  for (var k = 0; k < lines.length; k++) {
    var y = pad + lineHeight * (k + 0.5)
    draw.strokeText(lines[k], width / 2, y)
    draw.fillText(lines[k], width / 2, y)
  }

  return JSON.stringify({ width: width, height: height, lines: lines.length, size: size, data: canvas.toDataURL('image/png') })
})()`

  const webView = new WebViewController({ ephemeral: true })
  const path = `${FileManager.temporaryDirectory}/wm-text-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
  try {
    await webView.loadHTML(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:transparent"><canvas id="c" width="8" height="8"></canvas></body></html>`)
    const raw = await webView.evaluateJavaScript<string>(script)
    if (!raw) throw new Error("文字排版没有返回结果")
    const parsed = JSON.parse(raw) as { width?: number; height?: number; lines?: number; size?: number; data?: string; error?: string }
    if (parsed.error) throw new Error(parsed.error)
    if (!parsed.data) throw new Error("文字排版失败：没有拿到图像数据")
    const base64 = parsed.data.includes(",") ? parsed.data.slice(parsed.data.indexOf(",") + 1) : parsed.data
    const image = UIImage.fromBase64String(base64)
    if (!image) throw new Error("文字图像解析失败")
    const png = image.toPNGData()
    if (!png) throw new Error("文字图像编码失败")
    await FileManager.writeAsData(path, png)
    return {
      path,
      width: parsed.width ?? image.width,
      height: parsed.height ?? image.height,
      lines: parsed.lines ?? 1,
      fontSize: parsed.size ?? pixelSize,
    }
  } catch (error) {
    try { if (await FileManager.exists(path)) await FileManager.remove(path) } catch {}
    throw error
  } finally {
    webView.dispose()
  }
}

/** overlay 的定位表达式：W/H 是原图，w/h 是水印层 */
function overlayOffset(position: WatermarkPosition, margin: number): string {
  switch (position) {
    case "bottomLeft": return `x=${margin}:y=H-h-${margin}`
    case "topRight": return `x=W-w-${margin}:y=${margin}`
    case "topLeft": return `x=${margin}:y=${margin}`
    case "center": return `x=(W-w)/2:y=(H-h)/2`
    default: return `x=W-w-${margin}:y=H-h-${margin}`
  }
}

async function runFFmpeg(command: string, timeout = 600): Promise<void> {
  const result = await Shell.run(command, { timeout })
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg 处理失败：${result.output.slice(-300).replace(/[\r\n]+/g, " ")}`)
  }
}

export async function applyWatermark(
  inputPath: string,
  outputPath: string,
  kind: WatermarkMediaKind,
  text: string,
  style: WatermarkStyle = DEFAULT_STYLE,
): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error("水印内容不能为空")

  const frame = await frameSize(inputPath)
  const pixelSize = fontSizeFor(frame.width, style.sizePercent)
  const margin = Math.max(24, Math.round(frame.width / MARGIN_DIVISOR))
  const texture = await renderTextTexture(trimmed, style, pixelSize, frame)

  try {
    const offset = overlayOffset(style.position, margin)
    if (kind === "image") {
      await runFFmpeg(`ffmpeg -y -i "${inputPath}" -i "${texture.path}" -filter_complex "[0:v][1:v]overlay=${offset}" -frames:v 1 -q:v 2 "${outputPath}"`)
    } else {
      await runFFmpeg(`ffmpeg -y -i "${inputPath}" -i "${texture.path}" -filter_complex "[0:v][1:v]overlay=${offset}[v]" -map "[v]" -map 0:a? -c:v mpeg4 -q:v 3 -c:a aac -b:a 128k "${outputPath}"`)
    }
    if (!(await FileManager.exists(outputPath))) {
      throw new Error("未生成加水印文件")
    }
  } finally {
    try { if (await FileManager.exists(texture.path)) await FileManager.remove(texture.path) } catch {}
  }
}
