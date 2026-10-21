# PPT/PPTX 封面缩略图支持设计

**目标**：为 Serpent 提供 PPTX 包内嵌封面的缩略图提取能力。找不到可解码封面时直接失败，不引入外部转换器。本文已按 [2026-10-21 移除转换回退计划](../plans/2026-10-21-remove-libreoffice-fallback.md) 更新；此前可选 LibreOffice 回退设计已废止。

## 范围

- 支持 `.pptx` 的 `docProps/thumbnail.jpeg`、`docProps/thumbnail.jpg` 和 `docProps/thumbnail.png` 提取路径。
- PPT 没有新增的二进制源文件封面解码器；仍可展示导入或历史缓存中的有效封面。
- 缩略图写入既有 `revision_artifacts` 的 `thumbnail` 类型，使用现有卡片、Inspector 和缓存路径。
- 内嵌缩略图可以缺失或过期，不保证等于当前第一页；缺失、损坏、超限或无法解码时直接失败。
- 自动任务保留已有有效导入封面和历史 `ready` 缓存；没有可用封面时降级为通用文件图标，并持久化可去重、可诊断的失败终态。

## 非目标

- 本阶段不实现 PPT/PPTX 全文查看器。
- 不发现、配置、安装或调用 LibreOffice 等外部转换器，不将演示文稿转为临时 PDF。
- 不把 PPT/PPTX 直接加入现有 `DOCUMENT_EXTENSIONS`，避免二进制源文件进入 HTML 查看器。
- 不把 `ppt/media` 中任意图片冒充第一页完整渲染图。

## 架构

presentation 缩略图路径只提取 PPTX 内嵌 JPEG/PNG，再由 Sharp 规范化成标准 JPEG thumbnail artifact。未命中或解码失败时直接持久化失败；不启动外部进程，也不进入 PDF 渲染链。普通 PDF 缩略图能力保持独立。

PPT/PPTX 在本阶段保持 `other` 媒体语义，由共享 presentation 缩略图注册表声明扩展名并进入现有缩略图队列。这样卡片可以展示图片，而源文件仍由系统应用打开；完整 viewer 需要后续独立设计。

## 组件与数据流

1. `presentation-thumbnail.ts`：安全读取 PPTX 包内嵌 JPEG/PNG，校验大小和图片格式。不存在、损坏或超限的条目没有提取结果。
2. `LibraryService`：在缩略图生成入口调用 presentation provider，提取结果经 Sharp 规范化后写入 artifact；提取或解码失败直接记录 `PRESENTATION_THUMBNAIL_UNAVAILABLE`。
3. 共享媒体注册表：增加 presentation-only 扩展声明，供队列和 provider 识别；不改变 document viewer 分派。
4. generator-current 判定：使用 `pptx-embedded-thumbnail@1`；为读取已有缓存，继续识别历史 `presentation-soffice-pdfjs@1`，不会因此恢复转换能力。
5. 缓存与重试：失败 artifact 使用永久失败码 `PRESENTATION_THUMBNAIL_UNAVAILABLE` 和 generator `pptx-embedded-thumbnail@1;failed`，队列任务记为失败；后台补队列、自动失败修复和重开资源库不重复创建相同工作。取消不写失败终态，`enqueueArtifactRetry({ kind: 'thumbnail' })` 显式刷新或任务面板手动重试只重新提取封面，源文件 revision 变化可重新生成。自动任务保留已有 Eagle/Billfish 封面及旧 `ready` 缓存；显式刷新可以失效并重建，已运行的当前 revision 任务则合并处理。历史 `LIBREOFFICE_REQUIRED` 仅作为旧数据兼容，不再提示安装转换器。

## 失败与资源边界

- ZIP 通过 `yauzl` 有界读取条目，拒绝加密和异常压缩比；只读取固定名称的 thumbnail 条目，不解压完整归档。
- 不创建转换进程、转换专用临时目录或临时 PDF。
- 输出统一经过 Sharp 限制到最长边 512px 和 JPEG 质量 72；内嵌图超过限制或无法解码时直接记录失败终态。取消错误继续传播，清理半成品且不写入成功或失败 artifact。
- 内存压力、磁盘和数据库写入错误保留原有分类与重试策略；落盘/提交失败不等同于没有内嵌封面。
- 不使用 Python、Java 或远端云服务作为核心运行时依赖。

## 验证

- 单元测试覆盖 ZIP 缩略图读取、缺失/损坏/超限条目、路径大小写以及当前与历史 generator 判定。
- Worker 测试覆盖有效内嵌封面的 artifact 写入，缺失/损坏/超限/无法解码时直接失败且无进程启动，PPT 直接失败，永久失败去重，显式重试，导入和历史缓存保留，以及取消清理。
- 使用真实 PPTX fixture 检查内嵌封面提取结果，不将内嵌图等同于当前首页渲染。Windows/macOS/Linux 打包环境须分别记录验证证据。

