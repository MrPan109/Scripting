// 实况照片的「自选声音」
//
// 小红书网页版不提供实况照片的原始音轨（只有无声的 WEB_LIVEPHOTO 流），
// 所以这里让用户自己挑一段音频，保存时用系统原生 MediaComposer 合入动态里。
// 音频会被复制到 App Group 目录缓存，下次打开无需重新选择。
//
// 注意：FileManager.readDirectory 返回的是「文件名」而不是完整路径，
// 所以拼接、删除都必须自己补上目录前缀（踩过坑）。

const DIRECTORY = `${FileManager.appGroupDocumentsDirectory}/watermark-live-audio`
const PREFERENCES = `${DIRECTORY}/settings.json`
const PREFERENCES_NAME = "settings.json"

export interface LiveAudioSettings {
  /** 是否把这段音频合进实况照片 */
  enabled: boolean
  /** 缓存副本的完整路径 */
  audioPath: string | null
  /** 展示用的文件名 */
  fileName: string | null
  /** 音频总时长（秒），读不到时为 null */
  durationSeconds: number | null
  /** 从音频的第几秒开始取 */
  startSeconds: number
  /** 取到音频的第几秒（null 表示取到结尾） */
  endSeconds: number | null
}

function emptySettings(): LiveAudioSettings {
  return { enabled: false, audioPath: null, fileName: null, durationSeconds: null, startSeconds: 0, endSeconds: null }
}

/** readDirectory 只给文件名，这里统一转成完整路径。 */
async function cachedEntries(): Promise<Array<{ name: string; path: string }>> {
  try {
    return (await FileManager.readDirectory(DIRECTORY))
      .filter(name => !name.endsWith(PREFERENCES_NAME))
      .map(name => ({ name: name.split("/").pop() ?? name, path: `${DIRECTORY}/${name}` }))
  } catch {
    return []
  }
}

async function removeCachedAudio(): Promise<void> {
  for (const entry of await cachedEntries()) {
    try {
      if (await FileManager.exists(entry.path)) await FileManager.remove(entry.path)
    } catch {}
  }
}

async function persist(settings: LiveAudioSettings): Promise<void> {
  await FileManager.createDirectory(DIRECTORY, true)
  await FileManager.writeAsString(PREFERENCES, JSON.stringify(settings))
}

/**
 * 读取音频时长，同时当作格式校验：
 * 没有音频轨道或读不出时长（格式不支持、文件损坏、受版权保护的离线音乐）都会报错。
 */
export async function probeAudioDuration(path: string): Promise<number> {
  const asset = new AVAsset(path)
  try {
    const tracks = (await asset.loadTracks()).filter(track => String(track.mediaType) === "audio")
    if (tracks.length === 0) throw new Error("这个文件里没有音频轨道")
    const duration = await asset.loadDuration()
    if (!duration.isNumeric || !(duration.seconds > 0)) throw new Error("读不出音频时长")
    return duration.seconds
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${reason}。请换一个音频文件（支持 m4a / mp3 / wav / aiff / flac 等系统能解码的格式）`)
  } finally {
    asset.dispose()
  }
}

/** 把起点/终点夹到合法范围（终点必须晚于起点）。 */
function clampRange(settings: LiveAudioSettings): LiveAudioSettings {
  const total = settings.durationSeconds
  if (total === null || !(total > 0)) return { ...settings, startSeconds: 0, endSeconds: null }
  const start = Math.min(Math.max(0, settings.startSeconds), Math.max(0, total - 0.5))
  const end = settings.endSeconds === null ? null : Math.min(Math.max(start + 0.5, settings.endSeconds), total)
  return { ...settings, startSeconds: Math.round(start * 10) / 10, endSeconds: end === null ? null : Math.round(end * 10) / 10 }
}

/** 把一段音频收进缓存目录并启用（source 可以是「文件」里选来的路径）。 */
export async function adoptLiveAudio(source: string): Promise<LiveAudioSettings> {
  const rawName = source.split("/").pop() ?? "audio.m4a"
  const name = rawName.replace(/[/:]/g, "-")
  const target = `${DIRECTORY}/${name}`
  const extension = rawName.includes(".") ? rawName.split(".").pop() : "audio"
  // 暂存必须放在缓存目录之外，否则会被 removeCachedAudio 一并删掉
  const staging = `${FileManager.temporaryDirectory}/live-audio-import-${Date.now()}.${extension}`
  await FileManager.createDirectory(DIRECTORY, true)

  // 先复制到自己容器再校验：跨容器读取可能因权限失败，复制进来后一定读得到。
  await FileManager.copyFile(source, staging)
  let durationSeconds: number
  try {
    durationSeconds = await probeAudioDuration(staging)
  } catch (error) {
    try { await FileManager.remove(staging) } catch {}
    throw error
  }

  // 校验通过才动旧文件，失败时保留原有选择。
  await removeCachedAudio()
  try {
    await FileManager.copyFile(staging, target)
  } finally {
    try { if (await FileManager.exists(staging)) await FileManager.remove(staging) } catch {}
  }

  const settings: LiveAudioSettings = { enabled: true, audioPath: target, fileName: name, durationSeconds, startSeconds: 0, endSeconds: null }
  await persist(settings)
  return settings
}

export async function loadLiveAudioSettings(): Promise<LiveAudioSettings> {
  try {
    if (!(await FileManager.exists(PREFERENCES))) {
      const entries = await cachedEntries()
      if (entries.length === 1) {
        const duration = await probeAudioDuration(entries[0].path).catch(() => null)
        if (duration !== null) return { enabled: true, audioPath: entries[0].path, fileName: entries[0].name, durationSeconds: duration, startSeconds: 0, endSeconds: null }
      }
      return emptySettings()
    }
    const raw = JSON.parse(await FileManager.readAsString(PREFERENCES)) as Partial<LiveAudioSettings>
    const audioPath = typeof raw.audioPath === "string" && raw.audioPath.length > 0 ? raw.audioPath : null
    if (!audioPath || !(await FileManager.exists(audioPath))) {
      await clearLiveAudio()
      return emptySettings()
    }
    // 清掉不再被引用的残留文件（历史上删除失败留下的）
    for (const entry of await cachedEntries()) {
      if (entry.path !== audioPath) { try { await FileManager.remove(entry.path) } catch {} }
    }
    const durationSeconds = await probeAudioDuration(audioPath).catch(() => null)
    return clampRange({
      enabled: raw.enabled === true,
      audioPath,
      fileName: typeof raw.fileName === "string" && raw.fileName.length > 0 ? raw.fileName : audioPath.split("/").pop() ?? "音频",
      durationSeconds,
      startSeconds: typeof raw.startSeconds === "number" ? raw.startSeconds : 0,
      endSeconds: typeof raw.endSeconds === "number" ? raw.endSeconds : null,
    })
  } catch {
    return emptySettings()
  }
}

/** 让用户从「文件」里挑一段音频。取消返回 null；失败会把原因抛出来。 */
export async function importLiveAudio(): Promise<LiveAudioSettings | null> {
  const picked = await DocumentPicker.pickFiles({ types: ["public.audio"], allowsMultipleSelection: false })
  const source = picked && picked.length > 0 ? picked[0] : null
  if (!source) return null
  return adoptLiveAudio(source)
}

export async function setLiveAudioEnabled(enabled: boolean, settings: LiveAudioSettings): Promise<void> {
  await persist({ ...settings, enabled })
}

export async function setLiveAudioRange(startSeconds: number, endSeconds: number | null, settings: LiveAudioSettings): Promise<void> {
  await persist(clampRange({ ...settings, startSeconds, endSeconds }))
}

export async function clearLiveAudio(): Promise<void> {
  await removeCachedAudio()
  await persist(emptySettings())
}
