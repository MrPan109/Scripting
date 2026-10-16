import type { ResourceItem } from "../types/resource"

function createObservable<T>(initialValue: T): Observable<T> {
  const ObservableRuntime = Observable as any
  return new ObservableRuntime(initialValue) as Observable<T>
}

export const pageURL = createObservable("")
export const isLoading = createObservable(false)
export const statusText = createObservable("输入链接后点击「开始解析」")
export const resources = createObservable<ResourceItem[]>([])
export const pageTitle = createObservable("")
export const selectedCategory = createObservable("all")
export const initialViewMode = createObservable<"main" | "downloads">("main")
export const toastMessage = createObservable("")
export const toastVisible = createObservable(false)
export const filterInvalidResources = createObservable(false)
export const hideThumbnails = createObservable(false)
export const isFiltering = createObservable(false)
export const filterProgress = createObservable({ completed: 0, total: 0 })

// ── 去水印开关（默认开）：提取时尽量换成无水印源 ────────────────────────────
const PREFER_WATERMARK_FREE_KEY = "watermarkToolbox.preferWatermarkFree"

function loadPreferWatermarkFree(): boolean {
  try {
    const stored = Storage.get<boolean>(PREFER_WATERMARK_FREE_KEY)
    return typeof stored === "boolean" ? stored : true
  } catch {
    return true
  }
}

export const preferWatermarkFree = createObservable(loadPreferWatermarkFree())

export function setPreferWatermarkFree(value: boolean) {
  preferWatermarkFree.setValue(value)
  try { Storage.set(PREFER_WATERMARK_FREE_KEY, value) } catch {}
}

// ── YouTube 镜像兜底（默认开）──────────────────────────────────────────────
// YouTube 对部分视频只放行直链开头几百 KB，本机地址下到一半必然 403；
// 这时改用公共 Invidious 实例解析出的直链（只把视频 ID 发过去）。
const YOUTUBE_MIRROR_KEY = "watermarkToolbox.useYouTubeMirror"

function loadUseYouTubeMirror(): boolean {
  try {
    const stored = Storage.get<boolean>(YOUTUBE_MIRROR_KEY)
    return typeof stored === "boolean" ? stored : true
  } catch {
    return true
  }
}

export const useYouTubeMirror = createObservable(loadUseYouTubeMirror())

export function setUseYouTubeMirror(value: boolean) {
  useYouTubeMirror.setValue(value)
  try { Storage.set(YOUTUBE_MIRROR_KEY, value) } catch {}
}

export function showToast(message: string) {
  toastMessage.setValue(message)
  toastVisible.setValue(false)
  toastVisible.setValue(true)
}
