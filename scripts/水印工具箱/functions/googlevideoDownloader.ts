import { Script } from "scripting"
import type { ResourceItem } from "../types/resource"
import { ytDlpInstallPath } from "../services/ytDlpManager"
import { refreshMirrorResourceURLs } from "./youtubeMirror"
import type { SeparateMediaDownloadHandle } from "./separateMediaDownloader"

/**
 * googlevideo（YouTube 直链）专用下载器。
 *
 * 为什么不用 BackgroundURLSession：iOS 的信任链缺 googlevideo 的中间证书，
 * URLSession 会在握手阶段卡住（没有回调、落盘 0 字节），而 App 的 fetch 与
 * Python 侧的 SSL 适配都能正常取到数据。所以这里用 Python 分片下载：
 * 边下边把进度写进文件，JS 侧每秒读一次刷新进度条。
 *
 * 暂停/继续靠「取消文件 + 断点续传」实现：脚本每次都从已有文件长度接着下。
 */

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * 是不是 googlevideo 直链：这类地址系统 URLSession 下不动（证书链缺失会卡住），
 * 统一改走 Python 分片下载。
 */
export function isGooglevideoResource(resource: ResourceItem): boolean {
  return resource.source === "youtube" && /\/\/[^/]*googlevideo\.com\//i.test(resource.url)
}

const POLL_INTERVAL_MS = 1000
const TRACK_TIMEOUT_SECONDS = 6 * 60 * 60

type TrackSpec = {
  url: string
  path: string
  expected: number
  referer?: string
}

type ProgressState = { written: number; total: number }

async function removePath(path: string) {
  try {
    await FileManager.remove(path)
  } catch {}
}

async function readProgress(path: string): Promise<ProgressState | undefined> {
  try {
    const raw = await FileManager.readAsString(path)
    const parsed = JSON.parse(raw) as Partial<ProgressState>
    if (typeof parsed?.written !== "number") return undefined
    return { written: parsed.written, total: typeof parsed.total === "number" ? parsed.total : 0 }
  } catch {
    return undefined
  }
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function mergeMedia(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  const base = `ffmpeg -hide_banner -y -i ${quoteShellArg(videoPath)} -i ${quoteShellArg(audioPath)} -map 0:v:0 -map 1:a:0`
  const attempts = [
    `${base} -c copy -movflags +faststart ${quoteShellArg(outputPath)}`,
    `${base} -c:v copy -c:a aac -b:a 160k -movflags +faststart ${quoteShellArg(outputPath)}`,
  ]

  let lastOutput = ""
  for (const command of attempts) {
    await removePath(outputPath)
    const result = await Shell.run(command, { timeout: 7200 })
    lastOutput = result.output || ""
    if (!result.timedOut && result.exitCode === 0) return
  }

  const detail = lastOutput.trim().split("\n").slice(-4).join("\n")
  throw new Error(detail ? `音视频合并失败：${detail}` : "音视频合并失败")
}

export function startGooglevideoDownload(
  resource: ResourceItem,
  workPrefix: string,
  options: {
    onProgress?: (progress: number, totalBytesWritten: number) => void
    onStatus?: (label: string) => void
  } = {},
): SeparateMediaDownloadHandle {
  const videoPath = `${workPrefix}.video.mp4`
  const audioPath = `${workPrefix}.audio.m4a`
  const outputPath = `${workPrefix}.merged.mp4`
  const cancelPath = `${workPrefix}.cancel`

  let cancelled = false
  let paused = false
  let resumeSignal: (() => void) | null = null

  // 刚解析的直链直接使用；临近过期再刷新，避免每次下载都重跑镜像探测。
  const videoTrack: TrackSpec = {
    url: resource.url,
    path: videoPath,
    expected: resource.byteSize ?? 0,
    referer: resource.headers?.Referer,
  }
  let audioURL = resource.audioUrl

  async function refreshURLs() {
    if (!resource.videoFormatId) return
    const expiresSoon = (url: string) => {
      const match = /[?&]expire=(\d+)/.exec(url)
      return !match || Number(match[1]) * 1000 < Date.now() + 5 * 60 * 1000
    }
    if (!expiresSoon(videoTrack.url) && (!audioURL || !expiresSoon(audioURL))) return
    const fresh = await refreshMirrorResourceURLs(resource)
    if (!fresh) return
    videoTrack.url = fresh.url
    videoTrack.referer = fresh.headers?.Referer ?? videoTrack.referer
    if (fresh.audioUrl) audioURL = fresh.audioUrl
  }

  const estimatedTotal = (resource.byteSize ?? 0) + (resource.audioByteSize ?? 0)

  function audioTrackSpec(): TrackSpec | undefined {
    return audioURL
      ? { url: audioURL, path: audioPath, expected: resource.audioByteSize ?? 0, referer: videoTrack.referer }
      : undefined
  }

  /** 一个轨道的下载：跑脚本 + 每秒读进度文件；命中取消文件就退出（暂停/取消都走这条） */
  async function runTrack(spec: TrackSpec, writtenBefore: number, totalHint: number): Promise<{ written: number; interrupted: boolean }> {
    await waitWhilePaused()
    if (cancelled) throw new Error("用户已取消下载")
    await removePath(cancelPath)
    if (cancelled || paused) return { written: 0, interrupted: true }
    const progressPath = `${spec.path}.progress`
    await removePath(progressPath)

    const command = [
      "python",
      quoteShellArg(`${Script.directory}/scripts/youtube_url_download.py`),
      quoteShellArg(ytDlpInstallPath),
      quoteShellArg(spec.url),
      quoteShellArg(spec.path),
      "--size",
      String(spec.expected || 0),
      "--chunk-mb",
      "8",
      "--progress-file",
      quoteShellArg(progressPath),
      "--cancel-file",
      quoteShellArg(cancelPath),
      ...(spec.referer ? ["--referer", quoteShellArg(spec.referer)] : []),
    ].join(" ")

    let polling = true
    let lastWritten = 0
    const poll = (async () => {
      while (polling) {
        await sleep(POLL_INTERVAL_MS)
        if (!polling) break
        const progress = await readProgress(progressPath)
        if (!progress) continue
        lastWritten = progress.written
        const total = totalHint || progress.total || estimatedTotal
        if (total > 0) {
          options.onProgress?.(Math.min(95, Math.round(((writtenBefore + progress.written) / total) * 90)), writtenBefore + progress.written)
        }
      }
    })()

    const result = await Shell.run(command, { cwd: Script.directory, timeout: TRACK_TIMEOUT_SECONDS })
    polling = false
    await poll
    // 小文件可能在一秒内就下完，轮询还没轮到就结束了：以实际文件大小为准
    const stat = await FileManager.stat(spec.path).catch(() => undefined)
    const written = Math.max(lastWritten, stat?.size ?? 0)
    await removePath(progressPath)

    if (cancelled || paused || result.exitCode === 130) return { written, interrupted: true }
    if (result.timedOut) throw new Error("下载超时，可重试继续")
    if (result.exitCode !== 0) {
      const detail = (result.output || "").split("\n").map(line => line.trim()).filter(Boolean).slice(-3).join("\n")
      throw new Error(detail ? `视频下载失败：${detail}` : "视频下载失败")
    }
    return { written, interrupted: false }
  }

  /** 把一条轨道下完；中途暂停过就从断点接着下。 */
  async function downloadTrackFully(spec: TrackSpec, writtenBefore: number, totalHint: number): Promise<number> {
    let written = 0
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await runTrack(spec, writtenBefore, totalHint)
      written = run.written
      if (cancelled) throw new Error("用户已取消下载")
      if (!run.interrupted) return written
      await waitWhilePaused()
      if (cancelled) throw new Error("用户已取消下载")
      const status = await FileManager.stat(spec.path).catch(() => undefined)
      if (status && status.size > 0) written = status.size
    }
    throw new Error("反复暂停，下载已停止")
  }

  async function waitWhilePaused() {
    while (paused && !cancelled) {
      await new Promise<void>(resolve => {
        resumeSignal = resolve
        setTimeout(resolve, 500)
      })
    }
  }

  const result = (async () => {
    await Promise.all([removePath(videoPath), removePath(audioPath), removePath(outputPath), removePath(cancelPath)])
    if (cancelled) throw new Error("用户已取消下载")

    options.onStatus?.("正在准备直链...")
    await refreshURLs().catch(() => {})
    if (cancelled) throw new Error("用户已取消下载")

    const audioTrack = audioTrackSpec()
    options.onStatus?.(audioTrack ? "正在下载视频与音轨..." : "正在下载视频...")
    const videoSize = await downloadTrackFully(videoTrack, 0, estimatedTotal)
    if (cancelled) throw new Error("用户已取消下载")
    if (videoSize <= 0) throw new Error("视频轨没有下到数据")

    if (!audioTrack) {
      options.onProgress?.(100, videoSize)
      return { outputPath: videoPath, mimeType: "video/mp4" as const, fileSize: videoSize }
    }

    options.onStatus?.("正在下载音轨...")
    const audioSize = await downloadTrackFully(audioTrack, videoSize, estimatedTotal)
    if (cancelled) throw new Error("用户已取消下载")
    if (audioSize <= 0) throw new Error("音轨没有下到数据")

    options.onStatus?.("正在合并音视频...")
    options.onProgress?.(90, videoSize + audioSize)
    await mergeMedia(videoPath, audioPath, outputPath)
    if (cancelled) throw new Error("用户已取消下载")

    const fileSize = (await FileManager.stat(outputPath)).size
    await Promise.all([removePath(videoPath), removePath(audioPath)])
    options.onProgress?.(100, videoSize + audioSize)
    return { outputPath, mimeType: "video/mp4" as const, fileSize }
  })().catch(async error => {
    if (paused && !cancelled) {
      // 暂停：保留半成品，继续时接着下
      throw error
    }
    // 取消或真失败：清掉半成品（取消时给脚本一点时间先退出）
    setTimeout(() => {
      void Promise.all([removePath(videoPath), removePath(audioPath), removePath(outputPath), removePath(cancelPath)])
    }, 3000)
    throw error
  })

  return {
    result,
    cancel() {
      if (cancelled) return
      cancelled = true
      resumeSignal?.()
      // Python 侧每下一块都会看这个文件，写下去就会在下一块前退出
      FileManager.writeAsString(cancelPath, "cancel").catch(() => {})
    },
    pause() {
      if (cancelled || paused) return
      paused = true
      FileManager.writeAsString(cancelPath, "pause").catch(() => {})
    },
    resume() {
      if (cancelled || !paused) return
      paused = false
      resumeSignal?.()
    },
  }
}
