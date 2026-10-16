import { fetch } from "scripting"
import {
  detectDirectResourceType,
  getResourceFileName,
  parseHtmlResources,
  TYPE_LABELS,
} from "./resourceParsing"
import {
  mergeResourceLists,
  parseRuntimeSnapshotResources,
  readRuntimeSnapshot,
} from "./resourceRuntime"
import { validateResources } from "./resourceValidator"
import { applyWatermarkFree } from "./watermarkFree"
import { extractNativeResources, sharePlatformOf } from "./nativeResources"
import { extractURLFromText } from "../utils/url"
import { parseSiteResources } from "../services/parsers"
import {
  pageURL,
  isLoading,
  statusText,
  resources,
  pageTitle,
  selectedCategory,
  filterInvalidResources,
  hideThumbnails,
  preferWatermarkFree,
  showToast,
} from "../state/appState"

export async function extractResources() {
  const input = pageURL.value.trim()
  if (!input) {
    showToast("请输入有效的网址")
    return
  }

  const url = extractURLFromText(input)
  if (!url) {
    showToast("未找到有效的链接")
    return
  }
  pageURL.setValue(url)

  const targetURL = url
  isLoading.setValue(true)
  statusText.setValue("正在获取页面内容...")
  resources.setValue([])
  pageTitle.setValue("")
  selectedCategory.setValue("all")

  try {
    const platform = preferWatermarkFree.value ? sharePlatformOf(url) : null

    // 小红书作品：本机解析器直接读页面数据里的 fileId 原图，比通用提取（只能拿到
    // `!模板` 的 Web 压缩图）干净得多，所以优先走它。
    if (platform === "xiaohongshu") {
      statusText.setValue("正在用本机解析器获取来源图片...")
      try {
        const native = await extractNativeResources(url)
        if (native && native.items.length > 0) {
          resources.setValue(native.items)
          pageTitle.setValue(native.title || targetURL)
          const message = `已获取 ${native.items.length} 个媒体资源`
          statusText.setValue(message)
          showToast(message)
          return
        }
      } catch (error: any) {
        // 本机解析失败不致命，继续走通用提取，保证「至少能提取」
        statusText.setValue(`本机解析未成功，改用通用提取：${error?.message || "未知错误"}`)
      }
    }

    statusText.setValue("正在读取 Safari 保存的资源 JSON...")
    const savedSnapshot = await readRuntimeSnapshot(targetURL)
    if (savedSnapshot) {
      // 快照来自 Safari 页面，不重复请求网页或联网验证，以免登录资源被误删。
      let savedResources = parseRuntimeSnapshotResources(savedSnapshot, targetURL)
      let freeCount = 0
      if (preferWatermarkFree.value && savedResources.length > 0) {
        statusText.setValue("正在尝试获取无水印源...")
        const outcome = await applyWatermarkFree(savedResources, targetURL)
        savedResources = outcome.items
        freeCount = outcome.replaced
      }
      resources.setValue(savedResources)
      pageTitle.setValue(savedSnapshot.title || targetURL)
      const thumbCount = hideThumbnails.value
        ? savedResources.filter(item => item.likelyThumbnail).length
        : 0
      const freeSuffix = freeCount > 0 ? `，其中 ${freeCount} 个已替换为候选无水印源` : ""
      const message = savedResources.length > 0
        ? `已从 Safari JSON 读取 ${savedResources.length - thumbCount} 个资源${freeSuffix}${thumbCount > 0 ? ` (隐藏了 ${thumbCount} 个疑似缩略图)` : ""}`
        : "Safari JSON 中没有可提取的资源，请在网页加载完成后重新提取"
      statusText.setValue(message)
      showToast(message)
      return
    }

    statusText.setValue("正在获取页面内容...")
    const directType = detectDirectResourceType(targetURL)
    if (directType) {
      const fileName = getResourceFileName(targetURL)
      let directItem: any = { type: directType, url: targetURL, name: fileName }

      if (preferWatermarkFree.value && (directType === "image" || directType === "video")) {
        statusText.setValue("正在尝试获取无水印源...")
        const outcome = await applyWatermarkFree([directItem], targetURL)
        directItem = outcome.items[0]
      }

      if (filterInvalidResources.value) {
        statusText.setValue("正在验证直接资源有效性...")
        const validDirect = await validateResources([directItem], targetURL)
        if (validDirect.length === 0) {
          const message = "该直接资源链接无效或不是可预览的真实资源"
          resources.setValue([])
          pageTitle.setValue(fileName)
          statusText.setValue(message)
          showToast(message)
          return
        }
      }

      resources.setValue([directItem])
      pageTitle.setValue(fileName)
      const message = directItem.watermarkFree
        ? `已识别为直接${TYPE_LABELS[directType]}链接（已替换为候选无水印源）`
        : `已识别为直接${TYPE_LABELS[directType]}链接`
      statusText.setValue(message)
      showToast(message)
      return
    }

    let response = await fetch(targetURL)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    let pageTargetURL = response.url || targetURL
    let html = await response.text()

    statusText.setValue("正在解析资源...")

    let titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
    pageTitle.setValue(titleMatch ? titleMatch[1].trim() : pageTargetURL)

    statusText.setValue("正在解析站点资源...")
    let siteResult = await parseSiteResources({ url: pageTargetURL, html })
    const nextPageURL = siteResult.pageUrl
    if (nextPageURL && nextPageURL.split("#")[0] !== pageTargetURL.split("#")[0]) {
      statusText.setValue("正在获取作品页面...")
      response = await fetch(nextPageURL)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      pageTargetURL = response.url || nextPageURL
      pageURL.setValue(pageTargetURL)
      html = await response.text()
      titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
      pageTitle.setValue(titleMatch ? titleMatch[1].trim() : pageTargetURL)
      statusText.setValue("正在解析作品资源...")
      siteResult = await parseSiteResources({ url: pageTargetURL, html })
    }
    if (siteResult.title) pageTitle.setValue(siteResult.title)

    statusText.setValue("正在解析通用资源...")
    const htmlResults = parseHtmlResources(html, pageTargetURL, (message) => statusText.setValue(message))

    statusText.setValue("正在读取 Safari 运行时快照...")
    const runtimeSnapshot = await readRuntimeSnapshot(pageTargetURL)
    const runtimeResults = runtimeSnapshot
      ? parseRuntimeSnapshotResources(runtimeSnapshot, pageTargetURL)
      : []

    const merged = mergeResourceLists(siteResult.resources, runtimeResults, htmlResults)
    let results = merged
    let freeCount = 0

    // 抖音作品：站点解析（全程本机）没拿到媒体时，再用本机解析器兜底
    if (platform === "douyin" && !results.some(item => item.type === "video" || item.type === "image")) {
      statusText.setValue("正在用本机解析器获取媒体地址...")
      try {
        const native = await extractNativeResources(pageURL.value)
        if (native && native.items.length > 0) {
          results = mergeResourceLists(native.items, results)
        }
      } catch {}
    }

    if (preferWatermarkFree.value && results.length > 0) {
      statusText.setValue("正在尝试获取无水印源...")
      const outcome = await applyWatermarkFree(results, pageTargetURL, (completed, total) => {
        statusText.setValue(`正在尝试获取无水印源 (${completed}/${total})...`)
      })
      results = outcome.items
      freeCount = outcome.replaced
    }

    if (runtimeSnapshot?.title && (!pageTitle.value || pageTitle.value === pageTargetURL)) {
      pageTitle.setValue(runtimeSnapshot.title)
    }

    const freeSuffix = freeCount > 0 ? `，${freeCount} 个已替换为候选无水印源` : ""

    if (filterInvalidResources.value && results.length > 0) {
      statusText.setValue(`正在验证资源有效性 (0/${results.length})...`)
      const validResults = await validateResources(results, pageTargetURL, (completed, total) => {
        statusText.setValue(`正在验证有效性 (${completed}/${total})...`)
      })

      resources.setValue(validResults)
      const finalCount = validResults.length
      const filterCount = results.length - finalCount
      const thumbCount = hideThumbnails.value ? validResults.filter(r => r.likelyThumbnail).length : 0
      let message: string
      if (finalCount === 0) {
        message = "未发现有效的资源"
      } else if (filterCount > 0 && thumbCount > 0) {
        message = runtimeResults.length > 0
          ? `提取完成: ${finalCount - thumbCount} 个资源 (运行时捕获 ${runtimeResults.length} 个，过滤了 ${filterCount} 个失效项，隐藏了 ${thumbCount} 个疑似缩略图${freeSuffix})`
          : `提取完成: ${finalCount - thumbCount} 个资源 (过滤了 ${filterCount} 个失效项，隐藏了 ${thumbCount} 个疑似缩略图${freeSuffix})`
      } else if (filterCount > 0) {
        message = runtimeResults.length > 0
          ? `提取完成: ${finalCount} 个有效资源 (运行时捕获 ${runtimeResults.length} 个，过滤了 ${filterCount} 个失效项${freeSuffix})`
          : `提取完成: ${finalCount} 个有效资源 (过滤了 ${filterCount} 个失效项${freeSuffix})`
      } else if (thumbCount > 0) {
        message = runtimeResults.length > 0
          ? `提取完成，共发现 ${finalCount - thumbCount} 个资源 (运行时捕获 ${runtimeResults.length} 个，隐藏了 ${thumbCount} 个疑似缩略图${freeSuffix})`
          : `提取完成，共发现 ${finalCount - thumbCount} 个资源 (隐藏了 ${thumbCount} 个疑似缩略图${freeSuffix})`
      } else {
        message = runtimeResults.length > 0
          ? `提取完成，共发现 ${finalCount} 个资源 (运行时捕获 ${runtimeResults.length} 个${freeSuffix})`
          : `提取完成，共发现 ${finalCount} 个资源${freeSuffix}`
      }

      statusText.setValue(message)
      showToast(message)
      return
    }

    resources.setValue(results)
    const count = results.length
    const thumbCount = hideThumbnails.value ? results.filter(r => r.likelyThumbnail).length : 0
    const displayedCount = count - thumbCount
    const message = count > 0
      ? thumbCount > 0
        ? runtimeResults.length > 0
          ? `提取完成，共发现 ${displayedCount} 个资源 (运行时捕获 ${runtimeResults.length} 个，隐藏了 ${thumbCount} 个疑似缩略图${freeSuffix})`
          : `提取完成，共发现 ${displayedCount} 个资源 (隐藏了 ${thumbCount} 个疑似缩略图${freeSuffix})`
        : runtimeResults.length > 0
          ? `提取完成，共发现 ${count} 个资源 (运行时捕获 ${runtimeResults.length} 个${freeSuffix})`
          : `提取完成，共发现 ${count} 个资源${freeSuffix}`
      : "未发现可提取的资源"
    statusText.setValue(message)
    showToast(message)
  } catch (error: any) {
    const message = `提取失败: ${error.message || "未知错误"}`
    statusText.setValue(message)
    showToast(message)
  } finally {
    isLoading.setValue(false)
  }
}
