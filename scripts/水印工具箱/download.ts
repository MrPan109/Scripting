import { AbortController, fetch } from "scripting"
import { BROWSER_USER_AGENT, MediaItem, assertSafeMediaURL } from "./parser"

export interface SaveProgress { text: string; fraction?: number }

export interface SaveOptions {
  /** 实况照片可选的「自选声音」音频路径；不传则保存无声实况。 */
  audioPath?: string | null
  /** 从音频的第几秒开始取声音（默认 0）。 */
  audioStartSeconds?: number
  /** 取到音频的第几秒（不传或 null 表示取到结尾）。 */
  audioEndSeconds?: number | null
}

/** 读取视频画面尺寸，用于合成时保持原分辨率。 */
async function videoNaturalSize(path: string): Promise<{ width: number; height: number }> {
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)
  const asset = new AVAsset(path)
  try {
    const tracks = (await asset.loadTracks()).filter(track => String(track.mediaType) === "video")
    if (tracks.length > 0) {
      const size = await tracks[0].loadNaturalSize()
      if (size.width > 1 && size.height > 1) return { width: even(size.width), height: even(size.height) }
    }
  } catch {} finally {
    asset.dispose()
  }
  return { width: 1080, height: 1440 }
}

/** 校验音频并算出要用的片段范围（起点→终点）。 */
async function audioSourceRange(audioPath: string, startSeconds: number, endSeconds: number | null): Promise<MediaComposer.TimeRange> {
  const asset = new AVAsset(audioPath)
  try {
    const tracks = (await asset.loadTracks()).filter(track => String(track.mediaType) === "audio")
    if (tracks.length === 0) throw new Error("这个文件里没有音频轨道")
    const duration = await asset.loadDuration()
    if (!duration.isNumeric || !(duration.seconds > 0)) throw new Error("读不出音频时长")
    const total = duration.seconds
    const start = Math.min(Math.max(0, startSeconds), Math.max(0, total - 0.5))
    const desiredEnd = endSeconds === null || endSeconds === undefined ? total : endSeconds
    const end = Math.min(Math.max(start + 0.5, desiredEnd), total)
    return {
      start: MediaTime.make({ seconds: start, preferredTimescale: 600 }),
      duration: MediaTime.make({ seconds: Math.max(0.2, end - start), preferredTimescale: 600 }),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`自选声音不可用：${reason}。请换一个音频文件（支持 m4a / mp3 / wav / aiff / flac 等，受版权保护的离线音乐不行）`)
  } finally {
    asset.dispose()
  }
}

/** 用系统原生 MediaComposer 把音频合进实况动态（无需 ffmpeg，不会卡死）。 */
async function composeLivePhotoAudio(videoPath: string, audioPath: string, startSeconds: number, endSeconds: number | null, outputPath: string): Promise<void> {
  const renderSize = await videoNaturalSize(videoPath)
  const sourceTimeRange = await audioSourceRange(audioPath, startSeconds, endSeconds)
  await MediaComposer.composeAndExport({
    exportPath: outputPath,
    timeline: {
      videoItems: [{ videoPath, keepOriginalAudio: false }],
      audioClips: [{ path: audioPath, sourceTimeRange, volume: 1, loopToFitVideoDuration: true }],
    },
    exportOptions: {
      renderSize,
      frameRate: 30,
      scaleMode: "fit",
      presetName: "HighestQuality",
      outputFileType: "mp4",
    },
    overwrite: true,
  })
}

export async function saveMedia(item: MediaItem, controller: AbortController, report: (value: SaveProgress) => void, options: SaveOptions = {}): Promise<void> {
  const path = `${FileManager.temporaryDirectory}/${Date.now()}-${Math.random().toString(36).slice(2)}-${item.fileName}`
  let stage = "下载"
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const armTimeout = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { timedOut = true; controller.abort() }, 60000)
  }
  try {
    const urls = [item.url, ...(item.alternateUrls ?? [])]
    let response: any | undefined
    let url = ""
    let lastStatus = 0
    for (const candidate of urls) {
      try { url = assertSafeMediaURL(candidate) } catch { continue }
      const host = new URL(url).hostname
      const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`)
      const headers: Record<string, string> = { "User-Agent": BROWSER_USER_AGENT }
      if (matches("xhscdn.com") || matches("xiaohongshu.com")) headers.Referer = "https://www.xiaohongshu.com/"
      if (matches("douyin.com") || matches("iesdouyin.com")) headers.Referer = "https://www.douyin.com/"
      report({ text: "正在连接下载源…" })
      armTimeout()
      const candidateResponse = await fetch(url, { headers, signal: controller.signal, timeout: 600 })
      if (candidateResponse.ok) {
        response = candidateResponse
        break
      }
      lastStatus = candidateResponse.status
      if (candidateResponse.status !== 403 && candidateResponse.status !== 404) break
    }
    if (!response) throw new Error(`服务器返回 HTTP ${lastStatus || 502}，请重新解析作品后重试`)
    const mime = response.headers.get("content-type") ?? ""
    if (/text\/|json|xml|mpegurl/i.test(mime)) throw new Error("下载源返回的不是媒体文件，请重新解析作品")
    const total = response.expectedContentLength ?? 0
    const reader = response.dataStream.getReader()
    const file = FileEntity.openNewForWriting(path)
    let received = 0
    let lastReport = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (controller.signal.aborted) throw new Error("已取消")
        if (done) break
        if (!value || value.size === 0) continue
        file.write(value)
        received += value.size
        armTimeout()
        if (Date.now() - lastReport > 250) {
          const mb = (received / 1048576).toFixed(1)
          report({ text: total > 0 ? `下载 ${mb} / ${(total / 1048576).toFixed(1)} MB` : `已下载 ${mb} MB`, fraction: total > 0 ? Math.min(received / total, 1) : undefined })
          lastReport = Date.now()
        }
      }
    } finally {
      file.close()
      await reader.cancel().catch(() => {})
    }
    if (!received) throw new Error("下载内容为空")
    if (timer !== undefined) clearTimeout(timer)
    if (controller.signal.aborted) throw new Error("已取消")
    stage = item.kind === "audio" ? "导出文件" : item.kind === "livePhoto" ? "合成实况照片" : "写入相册"
    report({ text: stage === "写入相册" ? "正在写入相册…" : stage === "合成实况照片" ? "正在合成实况照片…" : "正在导出…" })
    if (item.kind === "audio") {
      const data = await FileManager.readAsData(path)
      const exported = await DocumentPicker.exportFiles({ files: [{ data, name: item.fileName }] })
      if (!exported.length) throw new Error("已取消导出")
    } else if (item.kind === "livePhoto") {
      // 参考官方「Video to Live Photo」远程脚本：读取源时长，
      // stillTime 取中间帧、maxDuration 跟随完整时长，shouldMoveFile 移动文件。
      let sourcePath = path
      let composedPath = ""
      if (options.audioPath) {
        report({ text: "正在合入自选声音…" })
        composedPath = `${FileManager.temporaryDirectory}/live-audio-${Date.now()}.mp4`
        await composeLivePhotoAudio(path, options.audioPath, options.audioStartSeconds ?? 0, options.audioEndSeconds ?? null, composedPath)
        sourcePath = composedPath
        report({ text: "正在生成实况照片…" })
      }
      try {
        const asset = new AVAsset(sourcePath)
        let coverTime = 0
        let outputDuration = 10
        try {
          const duration = await asset.loadDuration()
          if (duration.isNumeric && duration.seconds > 0) {
            outputDuration = Math.round(duration.seconds * 10) / 10
            coverTime = Math.round(Math.min(outputDuration / 2, Math.max(0, outputDuration - 0.01)) * 10) / 10
          }
        } catch {} finally {
          asset.dispose()
        }
        const pair = await LivePhoto.createFromVideo({
          videoPath: sourcePath,
          stillTime: coverTime,
          maxDuration: outputDuration,
          imageFormat: "jpeg",
          includeAudio: true,
        })
        await Photos.saveLivePhoto({ imagePath: pair.imagePath, videoPath: pair.videoPath, shouldMoveFile: true })
      } finally {
        if (composedPath) { try { if (await FileManager.exists(composedPath)) await FileManager.remove(composedPath) } catch {} }
      }
    } else {
      const success = item.kind === "video"
        ? await Photos.saveVideo(path, { fileName: item.fileName })
        : await Photos.savePhoto(path, { fileName: item.fileName })
      if (!success) throw new Error("系统未能保存，请检查相册添加权限及媒体格式")
    }
  } catch (error) {
    if (timedOut) throw new Error("下载源连续 60 秒没有返回数据。请重新解析作品后重试，或切换网络。")
    if (controller.signal.aborted) throw new Error("已取消")
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${stage}失败：${message.replace(/https?:\/\/\S+/g, "[媒体地址]")}`)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Cleanup must never turn a successful album import into a reported failure.
    try { if (await FileManager.exists(path)) await FileManager.remove(path) } catch {}
  }
}
