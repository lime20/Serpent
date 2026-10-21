# 新增媒体格式支持指南

本文面向参与 Serpent 软件开发的开发者。把扩展名加入一个列表，只代表某个入口“看见”了它；只有导入、缩略图、查看器、过滤和相关协议都验证过，才能称为支持。

## 1. 从共享注册表开始

先查看并修改 `src/shared/media-formats.ts`，必要时同步修改 `src/shared/audio-media.ts`：

- 图像加入 `IMAGE_EXTENSIONS` 的对应解码器集合；RAW 与普通图像不要混在错误的解码路径中。
- 视频、模型、文档加入对应注册表。
- 同一种 bitstream 的别名扩展名应共用 MIME 和解码策略。例如 JFIF 是 JPEG bitstream，`.jfif` 使用 `image/jpeg`，不是另造一种图像格式。
- 扩展名判断必须大小写不敏感；注册表函数应接收文件名和扩展名两种输入。

修改注册表后，不要在 UI 或 Worker 中再维护一份平行的硬编码扩展名列表。

## 2. 逐项检查消费者

用 `rg` 搜索旧扩展名、MIME、`endsWith`、`includes` 和格式分派点，然后按实际能力检查：

| 路径 | 重点位置 | 要确认的内容 |
| --- | --- | --- |
| 导入识别 | `src/worker/library-service.ts`、导入策略 | 文件能被识别、索引、重扫和删除；不支持或损坏时有明确结果 |
| 格式过滤 | `src/renderer/format-filter-presets.ts` | 从共享注册表生成，不遗漏新扩展名；补过滤单测 |
| 缩略图 | Worker thumbnail/媒体解码模块 | 解码器、尺寸上限、动画/多帧和损坏文件行为明确 |
| 查看器 | `src/shared/preview-policy.ts`、查看器组件 | 区分源文件直出与全分辨率派生图；不能把缩略图冒充原图 |
| MIME/协议 | `src/main/index.ts`、preload 和共享协议 | 主进程 artifact、远程资源、插件上下文使用正确 MIME，并通过运行时校验 |
| 序列帧/色彩 | sequence、image color space 相关模块 | 只有真正适用的图像格式进入序列帧和色彩管理路径 |
| 外部生态 | Eagle/Billfish、插件、远程导入 | 候选扩展名、URL MIME 和保存后的预览行为一致 |

图像格式是否能被 Chromium 原生显示只是优化条件，不是产品支持的充分条件。Chromium 不认识的容器应使用有界缩略图和独立的全分辨率解码路径。

### 透明度与「幻影坦克」贴图

带 alpha 的图片有两类查看语义，新增图像格式时必须分别确认：

- **普通透明贴图**：查看器保留 alpha，半透明像素与舞台底色合成。缩略图/预览派生图必须保留 alpha（Worker 在 `hasAlpha` 时输出 WebP，否则输出 JPEG）；把 alpha 抹成不透明底色的派生图等于破坏原图。
- **幻影坦克贴图**：同一张 PNG 在白底与黑底上分别显示两张不同画面（编码方式为 `alpha = 1 − (白底目标 − 黑底目标)`、`color = 黑底目标 / alpha`）。查看器在工具栏提供「图像背景」底色选择，并在采样帧符合该编码特征时提示切换背景。检测与底色模型位于 `src/renderer/mirage-texture.ts`，仅对降采样帧做启发式判断，不参与解码正确性。

因此，源文件直出与派生图路径都必须保留 alpha；派生图若使用有损/无 alpha 容器，幻影坦克贴图会退化成一张普通图片。

### 像素采样前提（跨域）

查看器需要读取媒体像素：幻影坦克检测与「上一张/下一张」按钮明暗对比都依赖 `canvas.getImageData`。`serpent://` 已在 `src/main/serpent-protocol-privileges.ts` 声明 `corsEnabled`，因此每条媒体响应（`artifact-response.ts` 的公共响应头）都必须带 `Access-Control-Allow-Origin`，查看器 `<img>` 也必须使用 `crossOrigin="anonymous"`。缺失任一项时画布会被跨域污染，采样静默返回空值——表现为检测提示永不出现、对比度永远停在默认值，而不是报错。新增媒体响应路径时要一并保持这两个条件。

### 缩略图的存储与加载

缩略图采用缓存优先、缺失时异步生成的方式，不会每次显示卡片都重新解码源文件：

- 数据库 `revision_artifacts` 保存 artifact 路径、状态、生成器版本、尺寸等索引信息；图片字节保存在资源库的 `.serpent/artifacts` 下，不以图片 BLOB 存入数据库。
- 查询以资产的 `current_revision_id` 为准，选择未失效的当前 artifact。已有可用的 `ready` 缓存时直接读取磁盘文件；滚动浏览或重开资源库通常复用同一份缓存。
- 缓存缺失或失效时，Worker 在后台排队生成并登记结果；当前可见资产优先调度，完成后通过 `asset.thumbnail.ready` 更新卡片。入队成功只表示任务已提交，不表示图片已经生成。
- 源文件 revision 变化、适用的生成器版本变化或手动刷新会触发重新生成。自动任务保留 Eagle/Billfish 的有效导入封面，不因其生成器与内置生成器不同而替换。

部分普通小图直接用源文件显示卡片，自动任务无需生成独立缩略图。该优化由 `src/shared/preview-policy.ts` 的 `isSourceDirectPreview` 统一判断：格式为 JPEG 系列、PNG、WebP、AVIF 或 GIF，大小为正且不超过 2 MiB，已知有效整数宽高，长边不超过 2048 像素且总像素不超过 2,000,000。超过这些限制的图片仍可入库，改走缩略图生成路径。

### 手动刷新缩略图

在资产右键菜单选择「刷新缩略图」，可对单个或多个图片、文档、模型、字体及 PPT/PPTX 重新生成封面，也支持跨页选择。入口只操作当前可写资源库中可用、未删除、未忽略且支持刷新的资产；执行时重新读取所选资产的最新摘要，跳过不支持或不可用的资产。菜单数量包含尚未加载的候选项，结果提示按实际成功提交的目标计数，并报告部分请求失败。视频和音频暂不提供此入口，因为现有重试接口对它们执行的是播放代理任务。

刷新复用 `retryArtifact({ kind: 'thumbnail' })`，以较高优先级提交或提升当前 revision 的持久任务。若该 revision 已有正在运行的生成或导入封面规范化任务，则沿用该任务，不使封面失效，也不改变它已经领取的处理意图。否则，刷新会失效当前缩略图并请求从源文件重建；排队或暂停中的导入封面规范化任务也会转为显式源文件刷新。显式图片刷新任务绕过自动任务的小图直显跳过规则，实际生成独立缩略图。原文件不修改，失败和取消沿用对应生成器的既有处理；实际生成仍在后台进行。

PPTX 刷新只重新提取文件内嵌封面，因此不能修正源文件内部已经过期的 `docProps/thumbnail.*`，也不渲染真实首页。缺少有效内嵌封面时直接失败，重复刷新不会凭空生成封面。PPT 没有源文件封面解码器；显式刷新已有导入封面前，应注意它可能无法从源文件重建。

## 3. 实现顺序

1. 判断新增的是编码格式、容器格式还是扩展名别名，记录 MIME、解码器和降级语义。
2. 更新共享注册表及其纯函数测试。
3. 逐个修正导入、Worker 解码、预览策略、格式过滤、主进程协议和插件/远程入口。
4. 若是动画、多帧、RAW、HDR 或 3D，先写清楚查看器语义：播放、首帧、帧控制、色彩空间、材质缺失等分别如何处理。
5. 更新开发者文档和人类验收清单；不要用“后端库理论上能读”代替真实证据。

`.blend` 不在产品格式表内：无可靠公开网格解析器覆盖 Blender 3–4.x，也不捆绑 Blender。文件可入库，按未知类型显示。需要预览时从 Blender 导出 glTF 或 FBX。FBX / OBJ / glTF / GLB / STL 走查看器 WebGL。

### PPT/PPTX 封面缩略图

`.ppt` / `.pptx` 当前只支持封面缩略图，媒体类型保持 `other`，不加入 `DOCUMENT_EXTENSIONS`；源文件不进入 HTML/PDF 查看器，已有封面可按图片查看。格式过滤器提供 PPT/PPTX 选项；这不代表已支持演示文稿全文查看。

- PPTX 只读取 `docProps/thumbnail.jpeg`、`docProps/thumbnail.jpg` 或 `docProps/thumbnail.png`，经 Sharp 规范化后写入普通 `thumbnail` artifact，generator 为 `pptx-embedded-thumbnail@1`。内嵌缩略图可以缺失或过期，不能保证等于当前第一页；不读取 `ppt/media` 中的任意图片来代替完整封面。
- 内嵌缩略图缺失、损坏、超限或无法解码时直接失败，不启动转换进程。PPT 没有新增的二进制封面解码器，也直接使用相同失败策略。该路径不依赖 LibreOffice、外部渲染器或安装/环境变量配置，普通 PDF 文件仍使用独立的 PDF.js 缩略图路径。
- 任务与 artifact 写入明确的 `PRESENTATION_THUMBNAIL_UNAVAILABLE` 永久失败终态，失败 generator 为 `pptx-embedded-thumbnail@1;failed`。界面说明文件没有可用内嵌封面；后台补队列、重开资源库及自动失败修复不会持续重试。取消不写失败终态；内存压力、磁盘或数据库写入错误保留原有错误分类，不误记为缺少封面。用户显式刷新或在任务面板手动重试可重新提取封面，源文件 revision 变化也可重新生成，但不会改用其他渲染方式。
- 自动任务保留 Eagle/Billfish 导入的有效封面和已有可用缓存，包括旧转换路径生成的 `ready` 封面；不会因移除转换器而清理缓存。历史 `presentation-soffice-pdfjs@1` / `LIBREOFFICE_REQUIRED` 只作为旧数据兼容标识读取，不再触发转换或安装提示。用户显式刷新可以失效并重建封面，但当前 revision 已运行的生成或规范化任务按上述合并规则沿用。

验收应覆盖：有效、缺失、损坏、超限及 Sharp 无法解码的内嵌图；失败时不启动外部进程；PPT 直接失败；取消；显式重试；失败后后台补队列不重复生成；Eagle/Billfish 原始与标准化封面和旧 `ready` 缓存的保留。Windows/macOS/Linux 打包环境须分别记录验证结果；本路径不做真实首页渲染验收。

### 诊断与任务控制

- 演示文稿没有可用内嵌封面时保留每项资产的 `PRESENTATION_THUMBNAIL_UNAVAILABLE` 失败记录；诊断不再检查或提示安装外部转换器。
- 为交互请求让出资源、返回排队状态的预期取消记为 info。正常关闭的 Worker `code: 0` 也属于 info。
- 普通源文件请求不逐条写日志。需要分析 PDF 等媒体的分段读取时，用 `SERPENT_VIEWER_TIMING_LOG=1` 启动，记录源文件版本、HTTP 方法、Range 及响应计时；请求数量本身不能证明循环生成。
- 「后台任务 → 重试失败项」会重新分页读取当前资源库的全部失败媒体任务，收集并去重后再提交，不依赖当前界面加载页。没有可重试项时不发送空 `jobIds`；协议继续要求至少一个 ID。AI 重试保留当前已加载列表的范围；列表没有失败项时禁用按钮，App 和 preload 也防止发送空选择。
- 开发服务器保留 CSP，以随机 nonce 允许 Vite/React 脚本，并允许开发所需 blob Worker；生产构建保留原策略。开发挂载超时记录页面/资源快照，窗口关闭后停止重试。原日志中的首次 20 秒空白尚未复现；隔离冷缓存启动及 HMR 已通过，不能据此宣称原空白根因已修复。

## 4. 测试矩阵

至少准备以下 fixture，路径使用临时目录，不提交个人绝对路径或真实用户素材：

- 有效文件、扩展名大写/混合大小写、非 ASCII 路径和较长文件名；
- 损坏/截断文件，以及格式声明和内容不一致的文件；
- 透明度、动画、多帧、RAW 或 HDR 等格式特有能力（适用时）；
- 导入后缩略图可解码，查看器原图可解码；图片检查 `complete && naturalWidth > 0`，视频检查元数据和非零尺寸；
- 搜索与格式过滤、重扫、删除/恢复、远程导入和插件入口（适用时）；
- macOS 与 Windows 的 packaged app；缺少平台证据时明确写“未验证”。

最小验证命令：

```bash
npm run typecheck
npx vitest run --config vitest.config.ts tests/unit/<相关测试>.test.ts
npm run test:unit
```

只要改动资源库打开、导入、Worker、schema 或媒体存储路径，还必须运行：

```bash
npm run test:library-availability
```

跨 Renderer / preload / Main / Worker 或自定义媒体协议的改动还要运行对应 Electron E2E。每次测试结束清理本次创建且能确认归属的临时数据库、媒体、截图和导出包。

## 5. 完成标准

开发日志和验收清单按四列记录：需求条目、实现位置（`file:line`）、自动化测试（`test:line`）、人工/平台证据。任意一列缺失，只能写“部分完成”或“未验证”。

相关调研：[媒体格式支持调研](research-media-format-support.md)。
