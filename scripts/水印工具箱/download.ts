import { AbortController, fetch } from "scripting"
import { BROWSER_USER_AGENT, MediaItem, assertSafeMediaURL } from "./parser"

export interface SaveProgress { text: string; fraction?: number }

export interface SaveOptions {
  /** 视频/实况可选的本地音频；优先于 backgroundAudio，同时提供时不下载 BGM。未选配乐保留原声。 */
  audioPath?: string | null
  /** 已解析的 BGM，必须为 kind: "audio"；仅用于视频/实况，不弹出文件选择器。 */
  backgroundAudio?: MediaItem | null
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

/** 实况合成前确认下载结果确实包含视频轨；HTTP 200 不代表拿到的是视频。 */
async function hasVideoTrack(path: string): Promise<boolean> {
  const asset = new AVAsset(path)
  try {
    return (await asset.loadTracks()).some(track => String(track.mediaType) === "video")
  } finally {
    asset.dispose()
  }
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
    const start = Math.min(Math.max(0, Number.isFinite(startSeconds) ? startSeconds : 0), Math.max(0, total - 0.5))
    const desiredEnd = endSeconds == null || !Number.isFinite(endSeconds) ? total : endSeconds
    const end = Math.min(Math.max(start + 0.5, desiredEnd), total)
    return {
      start: MediaTime.make({ seconds: start, preferredTimescale: 600 }),
      duration: MediaTime.make({ seconds: end - start, preferredTimescale: 600 }),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`配乐不可用：${reason}。请换一个音频文件（支持 m4a / mp3 / wav / aiff / flac 等，受版权保护的离线音乐不行）`)
  } finally {
    asset.dispose()
  }
}

function checkCancelled(controller?: AbortController): void {
  if (controller?.signal.aborted) throw new Error("已取消")
}

/** 原生替换音轨，音频片段循环到视频结束。输出由调用方拥有并清理。
 * controller 仅在原生合成前后检查取消，无法中断进行中的系统导出。
 */
export async function composeMediaAudio(videoPath: string, audioPath: string, startSeconds: number, endSeconds: number | null, outputPath: string, controller?: AbortController): Promise<void> {
  checkCancelled(controller)
  const renderSize = await videoNaturalSize(videoPath)
  const sourceTimeRange = await audioSourceRange(audioPath, startSeconds, endSeconds)
  checkCancelled(controller)
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
  checkCancelled(controller)
}

/** 仅下载到指定路径，复用备用源、原生请求超时和取消机制；不会导出文件或写相册。
 * 成功文件由调用方负责清理，失败尝试在此清理。
 */
async function downloadToPath(item: MediaItem, path: string, controller: AbortController, report: (value: SaveProgress) => void, requireAudioTrack = false): Promise<void> {
    const urls = [item.url, ...(item.alternateUrls ?? [])]
    let lastFailure = "没有可用的下载地址"
    let validSource = false
    for (const candidate of urls) {
      if (controller.signal.aborted) throw new Error("已取消")
      let url: string
      try { url = assertSafeMediaURL(candidate) } catch {
        lastFailure = "媒体地址无效或已被安全校验拒绝"
        continue
      }
      const host = new URL(url).hostname
      const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`)
      const headers: Record<string, string> = { "User-Agent": BROWSER_USER_AGENT }
      if (matches("xhscdn.com") || matches("xiaohongshu.com")) headers.Referer = "https://www.xiaohongshu.com/"
      if (matches("douyin.com") || matches("iesdouyin.com")) headers.Referer = "https://www.douyin.com/"
      const attempt = new AbortController()
      const forwardCancel = () => attempt.abort()
      controller.signal.addEventListener("abort", forwardCancel)
      if (controller.signal.aborted) forwardCancel()
      // AVAsset 的原生异步返回后可能不在主 JS 队列，不能再创建 JS Timer。
      // 使用请求自身的原生超时，覆盖主媒体、配乐、备用线路和连续保存。
      let response: Awaited<ReturnType<typeof fetch>> | undefined
      let reader: ReturnType<Awaited<ReturnType<typeof fetch>>["dataStream"]["getReader"]> | undefined
      let keepFile = false
      try {
        report({ text: "正在连接下载源…" })
        try {
          response = await fetch(url, { headers, signal: attempt.signal, timeout: 60 })
        } catch {
          if (controller.signal.aborted) throw new Error("已取消")
          lastFailure = "连接下载源失败或请求超时"
          continue
        }
        if (!response.ok) {
          lastFailure = `服务器返回 HTTP ${response.status}`
          continue
        }
        const mime = response.headers.get("content-type") ?? ""
        if (/text\/|json|xml|mpegurl/i.test(mime)) {
          lastFailure = "下载源返回了网页、错误信息或不支持的播放列表"
          continue
        }
        const total = response.expectedContentLength ?? 0
        reader = response.dataStream.getReader()
        // 文件打开/写入错误直接上抛，避免被误当成线路故障。
        const file = FileEntity.openNewForWriting(path)
        let received = 0
        let lastReport = 0
        let streamFailed = false
        try {
          while (true) {
            let chunk: Awaited<ReturnType<typeof reader.read>>
            try { chunk = await reader.read() } catch {
              if (controller.signal.aborted) throw new Error("已取消")
              lastFailure = "下载数据流中断或请求超时"
              streamFailed = true
              break
            }
            if (controller.signal.aborted) throw new Error("已取消")
            if (attempt.signal.aborted) {
              lastFailure = "下载请求已中止"
              streamFailed = true
              break
            }
            const { done, value } = chunk
            if (done) break
            if (!value || value.size === 0) continue
            file.write(value)
            received += value.size
            if (Date.now() - lastReport > 250) {
              const mb = (received / 1048576).toFixed(1)
              report({ text: total > 0 ? `下载 ${mb} / ${(total / 1048576).toFixed(1)} MB` : `已下载 ${mb} MB`, fraction: total > 0 ? Math.min(received / total, 1) : undefined })
              lastReport = Date.now()
            }
          }
        } finally {
          file.close()
        }
        if (streamFailed) continue
        if (!received) {
          lastFailure = "下载源返回了空文件"
          continue
        }
        // HTTP 200（包括 audio/mp4）不代表有视频轨；读取失败与无轨分别报告。
        if (item.kind === "livePhoto") {
          let hasVideo: boolean
          try { hasVideo = await hasVideoTrack(path) } catch {
            lastFailure = "无法读取下载文件的媒体轨道"
            continue
          }
          if (!hasVideo) {
            lastFailure = "下载文件不含视频轨道，无法生成实况照片"
            continue
          }
        }
        if (requireAudioTrack) {
          const asset = new AVAsset(path)
          try {
            const tracks = await asset.loadTracks()
            if (!tracks.some(track => String(track.mediaType) === "audio")) {
              lastFailure = "下载的配乐不含音频轨道"
              continue
            }
          } catch {
            lastFailure = "无法读取下载配乐的媒体轨道"
            continue
          } finally {
            asset.dispose()
          }
        }
        checkCancelled(controller)
        validSource = true
        keepFile = true
        break
      } finally {
        controller.signal.removeEventListener("abort", forwardCancel)
        // 包括拒绝响应、打开文件失败和读流失败的路径。
        try {
          if (reader) await reader.cancel()
          else if (response) await response.dataStream.getReader().cancel()
        } catch {} finally {
          attempt.abort()
        }
        if (!keepFile) { try { if (await FileManager.exists(path)) await FileManager.remove(path) } catch {} }
      }
    }
    if (!validSource) throw new Error(`${lastFailure}，请重新解析作品后重试`)
    checkCancelled(controller)
}

export async function saveMedia(item: MediaItem, controller: AbortController, report: (value: SaveProgress) => void, options: SaveOptions = {}): Promise<void> {
  const temporaryPath = (name: string) => `${FileManager.temporaryDirectory}/${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`
  const path = temporaryPath(item.fileName)
  const temporaryPaths = [path]
  let stage = "下载"
  try {
    await downloadToPath(item, path, controller, report)
    checkCancelled(controller)
    let sourcePath = path
    if ((item.kind === "video" || item.kind === "livePhoto") && (options.audioPath || options.backgroundAudio)) {
      let audioPath = options.audioPath
      if (!audioPath && options.backgroundAudio) {
        stage = "下载配乐"
        if (options.backgroundAudio.kind !== "audio") throw new Error("所选配乐必须是音频")
        const backgroundPath = temporaryPath(options.backgroundAudio.fileName)
        temporaryPaths.push(backgroundPath)
        await downloadToPath(options.backgroundAudio, backgroundPath, controller, value => report({ ...value, text: `配乐：${value.text}` }), true)
        audioPath = backgroundPath
      }
      checkCancelled(controller)
      stage = "合入配乐"
      report({ text: "正在合入配乐…" })
      const composedPath = temporaryPath("composed-audio.mp4")
      temporaryPaths.push(composedPath)
      await composeMediaAudio(path, audioPath!, options.audioStartSeconds ?? 0, options.audioEndSeconds ?? null, composedPath, controller)
      sourcePath = composedPath
    }
    checkCancelled(controller)
    stage = item.kind === "audio" ? "导出文件" : item.kind === "livePhoto" ? "合成实况照片" : "写入相册"
    report({ text: stage === "写入相册" ? "正在写入相册…" : stage === "合成实况照片" ? "正在合成实况照片…" : "正在导出…" })
    if (item.kind === "audio") {
      const data = await FileManager.readAsData(path)
      checkCancelled(controller)
      const exported = await DocumentPicker.exportFiles({ files: [{ data, name: item.fileName }] })
      if (!exported.length) throw new Error("已取消导出")
    } else if (item.kind === "livePhoto") {
      // 参考官方「Video to Live Photo」远程脚本：读取源时长，
      // stillTime 取中间帧、maxDuration 跟随完整时长，shouldMoveFile 移动文件。
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
      checkCancelled(controller)
      const pair = await LivePhoto.createFromVideo({
        videoPath: sourcePath,
        stillTime: coverTime,
        maxDuration: outputDuration,
        imageFormat: "jpeg",
        includeAudio: true,
      })
      temporaryPaths.push(pair.imagePath, pair.videoPath)
      checkCancelled(controller)
      stage = "写入相册"
      report({ text: "正在写入相册…" })
      checkCancelled(controller)
      await Photos.saveLivePhoto({ imagePath: pair.imagePath, videoPath: pair.videoPath, shouldMoveFile: true })
    } else {
      checkCancelled(controller)
      const success = item.kind === "video"
        ? await Photos.saveVideo(sourcePath, { fileName: options.audioPath || options.backgroundAudio ? item.fileName.replace(/\.[^.]+$/, "") + ".mp4" : item.fileName })
        : await Photos.savePhoto(sourcePath, { fileName: item.fileName })
      if (!success) throw new Error("系统未能保存，请检查相册添加权限及媒体格式")
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error("已取消")
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${stage}失败：${message.replace(/https?:\/\/\S+/g, "[媒体地址]")}`)
  } finally {
    // Cleanup must never turn a successful album import into a reported failure.
    for (const temporaryPath of temporaryPaths) {
      try { if (await FileManager.exists(temporaryPath)) await FileManager.remove(temporaryPath) } catch {}
    }
  }
}
