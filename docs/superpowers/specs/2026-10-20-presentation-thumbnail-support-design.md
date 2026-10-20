# PPT/PPTX 封面缩略图支持设计

**目标**：为 Serpent 增加 PPT/PPTX 封面缩略图生成能力，优先使用 PPTX 包内嵌缩略图，并在可选的系统 LibreOffice 可用时为 PPT/PPTX 生成真实第一页缩略图。

## 范围

- 支持 `.pptx` 的 `docProps/thumbnail.jpeg` 和 `docProps/thumbnail.png` 快速路径。
- 支持通过系统 `soffice` 将 `.ppt`/`.pptx` 转为临时 PDF，再复用 Serpent 现有 PDF 首页渲染链。
- 缩略图写入既有 `revision_artifacts` 的 `thumbnail` 类型，使用现有卡片、Inspector 和缓存路径。
- 转换失败、未安装 LibreOffice 或 PPTX 没有内嵌缩略图时降级为通用文件图标，并保留可诊断的失败状态。

## 非目标

- 本阶段不实现 PPT/PPTX 全文查看器。
- 不将 LibreOffice 打进 Serpent 核心安装包。
- 不把 PPT/PPTX 直接加入现有 `DOCUMENT_EXTENSIONS`，避免二进制源文件进入 HTML 查看器。
- 不把 `ppt/media` 中任意图片冒充第一页完整渲染图。

## 架构

实现一个 presentation thumbnail provider，优先尝试 PPTX 内嵌缩略图；未命中时按配置解析 `soffice`，在受控临时目录中转换 PDF，再调用共享的 PDF 首页面渲染函数。两条路径最终都产生标准 JPEG thumbnail artifact，并以独立 generator version 区分，保证缓存和过期判断稳定。

PPT/PPTX 在本阶段保持 `other` 媒体语义，由 thumbnail provider 声明扩展名并进入现有缩略图队列。这样卡片可以展示图片，而源文件仍由系统应用打开；完整 viewer 需要后续独立设计。

## 组件与数据流

1. `presentation-thumbnail.ts`：安全读取 PPTX 包内嵌缩略图，校验大小和图片格式，并提供 `soffice` 路径解析与受控转换接口。
2. `LibraryService`：在缩略图生成入口先调用 presentation provider；内嵌路径直接进入 Sharp 规范化，转换路径复用 PDF 首页渲染和 artifact 写入。
3. 共享媒体注册表：增加 presentation-only 扩展声明，供队列和 provider 识别；不改变 document viewer 分派。
4. generator-current 判定：识别 `pptx-embedded-thumbnail@1` 和 `presentation-soffice-pdfjs@1`，避免成功后重复失效重生成。

## 失败与资源边界

- ZIP 读取复用 `yauzl` 的有界读取、加密/符号链接/压缩比拒绝策略；只读取固定 thumbnail 条目。
- `soffice` 使用临时 profile、单槽并发、AbortSignal 和进程清理；转换超时或退出码异常时不保留半成品。
- 输出统一经过 Sharp 限制到最长边 512px 和 JPEG 质量 72；超过限制或无法解码时进入 benign failure。
- 不使用 Python、Java 或远端云服务作为核心运行时依赖。

## 验证

- 单元测试覆盖 ZIP 缩略图读取、缺失/损坏/超限条目、路径大小写、generator current 判定和 provider fallback。
- Worker 测试覆盖 PPT/PPTX 进入缩略图队列、artifact 写入、失败降级和取消清理。
- 使用真实 PPT/PPTX fixture 做人工渲染验收；缺少跨平台 LibreOffice 环境时明确标记未验证。

