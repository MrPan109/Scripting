import {
  Section,
  Text,
  Button,
  HStack,
  ProgressView,
  ScrollView,
  Toggle,
} from "scripting"
import type { ResourceItem } from "../types/resource"
import {
  pageURL,
  isLoading,
  statusText,
  resources,
  pageTitle,
  selectedCategory,
  filterInvalidResources,
  hideThumbnails,
  isFiltering,
  filterProgress,
  preferWatermarkFree,
  setPreferWatermarkFree,
  useYouTubeMirror,
  setUseYouTubeMirror,
  showToast,
  beginParseTask,
  isCurrentParseTask,
} from "../state/appState"
import { extractResources } from "../functions/resourceExtractor"
import { getCategoryStats, getFilteredResources } from "../functions/resourceInfo"
import { validateResources } from "../functions/resourceValidator"
import { ResourceItemRow } from "../components/ResourceItemRow"

/**
 * 「网页资源提取」的结果区（原来 MainView 的正文）。
 * 单独抽出来是为了能和「作品解析」的结果放进同一个列表 ——
 * 合并后的一个输入框，作品走作品区、网页走这里。
 */
export function ExtractSections({ hideEmptyOptions = false }: { hideEmptyOptions?: boolean } = {}) {
  const filtered = getFilteredResources()
  const categoryStats = getCategoryStats()
  const listTitle = pageTitle.value || "资源列表"
  const hasResources = resources.value.length > 0

  return (
    <>
      {hasResources ? (
        <Section title="显示选项">
          <Toggle
            title="优先使用原始资源"
            value={preferWatermarkFree.value}
            disabled={isFiltering.value || isLoading.value}
            onChanged={(v: boolean) => {
              setPreferWatermarkFree(v)
              showToast(v ? "已开启：优先使用可用的原始资源" : "已关闭原始资源优先")
              void extractResources()
            }}
          />
          {preferWatermarkFree.value ? (
            <Text font="caption" foregroundStyle="secondaryLabel">
              对于支持的资源，尝试获取来源站点提供的原始版本，验证地址可访问后使用。资源不一定存在原始版本。
            </Text>
          ) : null}
          <Toggle
            title="过滤失效资源"
            value={filterInvalidResources.value}
            disabled={isFiltering.value || isLoading.value}
            onChanged={async (v: boolean) => {
              filterInvalidResources.setValue(v)
              if (v && resources.value.length > 0) {
                const task = beginParseTask()
                const candidates = resources.value
                const referer = pageURL.value
                isFiltering.setValue(true)
                filterProgress.setValue({ completed: 0, total: candidates.length })
                try {
                  const validResults = await validateResources(candidates, referer, (completed, total) => {
                    if (isCurrentParseTask(task)) filterProgress.setValue({ completed, total })
                  })
                  if (!isCurrentParseTask(task)) return
                  const filterCount = candidates.length - validResults.length
                  resources.setValue(validResults)
                  showToast(filterCount > 0 ? `已过滤 ${filterCount} 个失效资源` : "所有资源均有效")
                } catch (err: any) {
                  if (isCurrentParseTask(task)) {
                    showToast(`过滤失败: ${err.message}`)
                    filterInvalidResources.setValue(false)
                  }
                } finally {
                  if (isCurrentParseTask(task)) {
                    isFiltering.setValue(false)
                    filterProgress.setValue({ completed: 0, total: 0 })
                  }
                }
              } else if (!v && resources.value.length > 0) {
                await extractResources()
              }
            }}
          />
          {isFiltering.value ? (
            <HStack spacing={8} padding={{ vertical: 2 }}>
              <ProgressView />
              <Text font="subheadline" lineLimit={1} foregroundStyle="secondaryLabel">
                正在过滤失效资源 ({filterProgress.value.completed}/{filterProgress.value.total})
              </Text>
            </HStack>
          ) : null}
          <Toggle
            title="隐藏疑似图标/缩略图"
            value={hideThumbnails.value}
            disabled={isFiltering.value}
            onChanged={(v: boolean) => {
              hideThumbnails.setValue(v)
              if (v) {
                const count = resources.value.filter((r: ResourceItem) => r.likelyThumbnail).length
                showToast(count > 0 ? `已隐藏 ${count} 个疑似图标/缩略图` : "当前没有疑似缩略图的资源")
              }
            }}
          />
        </Section>
      ) : null}

      {!hasResources && !isLoading.value && !hideEmptyOptions ? (
        <Section title="网页提取选项">
          <Toggle
            title="优先使用原始资源"
            value={preferWatermarkFree.value}
            onChanged={(v: boolean) => setPreferWatermarkFree(v)}
          />
          {preferWatermarkFree.value ? (
            <Text font="caption" foregroundStyle="secondaryLabel">
              尝试使用来源站点提供的原始媒体版本。请保留依法应保留的署名及权利标识，并确认你已获得相应授权。
            </Text>
          ) : null}
          <Toggle
            title="过滤失效资源"
            value={filterInvalidResources.value}
            onChanged={(v: boolean) => filterInvalidResources.setValue(v)}
          />
          {filterInvalidResources.value ? (
            <Text font="caption" foregroundStyle="secondaryLabel">
              开启后将对提取到的资源进行存活性检测，耗时会稍微增加。
            </Text>
          ) : null}
          <Toggle
            title="隐藏疑似图标/缩略图"
            value={hideThumbnails.value}
            onChanged={(v: boolean) => hideThumbnails.setValue(v)}
          />
          {hideThumbnails.value ? (
            <Text font="caption" foregroundStyle="secondaryLabel">
              开启后将根据 URL 模式自动隐藏小图标和缩略图资源。
            </Text>
          ) : null}
          <Toggle
            title="公共镜像备用来源"
            value={useYouTubeMirror.value}
            onChanged={(v: boolean) => setUseYouTubeMirror(v)}
          />
          <Text font="caption" foregroundStyle="secondaryLabel">
            部分视频的直接下载地址可能受限。开启后会尝试向第三方公共镜像查询备用地址，并将视频标识发送给该服务；媒体仍在本机下载。镜像可用性与隐私政策由服务提供方决定，关闭后仅使用本机解析的地址。
          </Text>
        </Section>
      ) : null}

      {hasResources ? (
        <Section title={listTitle}>
          <ScrollView axes="horizontal" scrollIndicator="never">
            <HStack spacing={4} padding={{ vertical: 2 }}>
              <Button
                action={() => selectedCategory.setValue("all")}
                buttonStyle={selectedCategory.value === "all" ? "borderedProminent" : "bordered"}
                controlSize="small"
                clipShape={{ type: "capsule", style: "circular" }}
              >
                <Text font="caption2">全部 ({resources.value.length})</Text>
              </Button>
              {categoryStats.map(cat => (
                <Button
                  key={cat.type}
                  action={() => selectedCategory.setValue(cat.type)}
                  buttonStyle={selectedCategory.value === cat.type ? "borderedProminent" : "bordered"}
                  controlSize="small"
                  clipShape={{ type: "capsule", style: "circular" }}
                >
                  <Text font="caption2">{cat.label} ({cat.count})</Text>
                </Button>
              ))}
            </HStack>
          </ScrollView>

          {filtered.length > 0 ? (
            filtered.map((item: ResourceItem, index: number) => (
              <ResourceItemRow key={`${item.type}-${index}`} item={item} />
            ))
          ) : (
            <Text foregroundStyle="secondaryLabel" font="caption" padding={10}>
              当前分类没有资源。
            </Text>
          )}
        </Section>
      ) : null}
    </>
  )
}
