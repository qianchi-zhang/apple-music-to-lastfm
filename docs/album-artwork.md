# 聆听记录与真实专辑封面

聆听记录页直接展示歌曲，桌面采用左侧最近记录、右侧唱片展示的双栏布局。右侧保留原有封套与黑胶唱片造型，把抽象封面替换为后台最新记录对应的真实专辑封面；左侧每条记录也尝试显示对应的真实封面。窄窗口和手机按响应式规则排列。

页面和客户端状态只保留最近 10 首，没有搜索或日期筛选。「查看更多」使用当前已验证、已连接的 Last.fm 用户名，安全编码后打开用户主页 `https://www.last.fm/user/<用户名>`，不附加 `/library`；账户未知、失去验证或已断开时移除链接，避免跳到旧账户。更长的聆听历史在 Last.fm 查看。

右侧最新曲目以后台 `runtime.records[0]` 为准，不表示正在播放，也不通过点击历史歌曲切换。没有记录、没有可用的原始 `track_id` 或兼容的 `catalog_id`、后台未返回图片或图片加载失败时，显示中性音乐图标占位，歌曲信息和记录状态仍正常展示。实际账户按匹配前的 Apple 曲目 ID 获取封面，不按提交后的歌曲名或专辑名搜索、猜测封面，也不借用演示封面填充真实记录。

## 更新方式

聆听记录页可见、连接面板关闭时，每 30 秒只读刷新后台记录；页面隐藏、服务正忙或已有刷新请求时跳过。窗口重新获得焦点或页面重新可见时也会尝试刷新，并保留已有的刷新去重和短间隔保护。

这些请求读取后台已保存的记录，不读取即时播放器，不启动 Apple 历史采集，不开启记录，也不提交歌曲。后台记录更新后，右侧跟随新的 `records[0]` 更新封面；它的及时程度仍取决于后台原有记录周期。

## 封面接口

```http
GET /api/v1/artwork?track_id=1854820331
x-ascrobble-auth: <管理密钥>
```

```json
{ "artwork_url": "https://is1-ssl.mzstatic.com/…/600x600bb.jpg" }
```

接口沿用管理密钥认证和既有的有效设置会话认证。优先使用记录保留的原始 `track_id`，支持数字歌曲 ID 及 `i.` 开头的资料库歌曲 ID；旧记录只含目录 ID 时，兼容 `?catalog_id=<数字 ID>`。每次只能使用一个查询标识，不能同时传入两种参数或重复同一参数。ID 必须属于当前 Last.fm 账户可见的最近 10 条记录；`/api/v1/recording` 也最多返回 10 条。账户切换不会允许读取原账户的封面。

数字 ID 先使用 Apple 公开接口 `https://itunes.apple.com/lookup?id=<歌曲 ID>&entity=song` 精确查询，不携带 Apple、Last.fm 或管理凭据；仅接受返回值中 `trackId` 相同、类型为歌曲的项目。公开接口无可用封面时，若已有 Apple 连接，则继续使用原生 API：资料库歌曲读取 `/v1/me/library/songs/<原始 ID>`；目录歌曲先读取 `/v1/me/storefront`，再读取 `/v1/catalog/{storefront}/songs/<ID>`。已有播放快照能确认对应的原始资料库 ID 时，沿用该 ID 读取，不替换为提交后的文字匹配结果。

只返回精确歌曲对应的 `artworkUrl100` 或 `attributes.artwork.url`，将可用图片尺寸规范为 600；Apple 的 [Artwork 对象](https://developer.apple.com/documentation/applemusicapi/artwork) 使用的 `{w}`、`{h}` 模板也会替换。不进行关键词搜索，不把 Apple 凭据返回前端，也不把凭据加入图片地址。

未知 ID、非法参数、超出当前账户范围、无图及可预期的上游失败返回 `200` 和 `artwork_url: null`；需要原生资料库查询但没有 Apple 连接时也返回空图。响应同时提供固定的 `artwork_status`、`stage`，以及适用的 `lookup_kind`、`resource_kind`、`apple_http_status`，用于区分无图、超时、网络错误和 Apple HTTP 错误；不回显上游正文或凭据。未认证请求继续返回 `401`。

封面查询位于生产算法之外，不修改冻结的 `worker-0.3.111.js`，不写入歌曲队列、账本、连接、开关或 Alarm。它不占用记录业务的串行队列，也不为 `/api/v1/recording` 的状态查询增加 Apple 请求。一次查询的公开接口、原生 API 及回退共用 5 秒截止时间；服务端使用 Workers 支持的 `redirect: "manual"`，拒绝非成功响应，不跟随重定向转发凭据。

当前 Worker 代码和扩展部署载荷均包含此接口。生成或下载安装包不会自动更新已部署的后台；旧后台缺少接口时，客户端将 `404` 等情况降级为无封面，不改变记录开关或主错误提示。已有部署可通过「设置 → 更新个人后台」或「重新连接 Cloudflare」原地更新，不必重新授权音乐账户。已有只返回 6 条记录的后台也需更新后才会提供第 7–10 条；十首范围仅限制展示及封面缓存，不清除冻结算法内部的账本或待提交队列。

## 图片安全与缓存

服务端和客户端都限制图片地址：仅允许 HTTPS 的 `mzstatic.com` 或其真正子域，拒绝 URL 用户名、密码、非默认端口、其他主机、其他协议及未完成替换的模板。客户端另外精确允许下面六个随包附带的演示图片路径，不放开任意本地路径。图片使用 `no-referrer`，加载失败时恢复占位。

服务端缓存仅驻留当前实例内存，最多 10 项；成功封面有效 30 分钟，无图或失败有效 60 秒。每次读取状态或封面时主动清除已移出最近 10 首的条目；上游返回前再次核对，失效请求不回填。账户 Apple 凭据变化时清空缓存，命中前仍核对实际记录归属。封面响应的 HTTP 缓存策略为 `no-store`，与这些服务内部的短期内存缓存分开。

客户端最多同时发起 3 个封面查询，最多追踪当前 10 首的请求；同一安装、同一 Last.fm 账户及同一 ID 的进行中请求共享 Promise，右侧与列表不重复发起相同查询。成功封面地址在内存及扩展的 `chrome.storage.local` 中保留最长 7 天；只持久化通过上述 HTTPS 校验的图片 URL、曲目标识、过期时间和账户范围哈希，不保存图片文件、不额外复制明文管理钥匙，也不持久化无图或失败结果。演示图片路径不进入持久缓存，无图或失败仅在本页内存缓存 60 秒。

本地缓存最多保存当前最近十首的有效封面地址，刷新或重新打开扩展时，先读取并核对后台及账户范围，再复用未过期的条目。移出列表、过期、切换后台或账户时清理相应缓存；图片加载失败时仅移除该条对应的失效 URL，后续可重新查询；更新后台成功也会清理封面缓存。并发页面使用独立缓存锁和版本校验，迟到的旧请求或图片错误不能覆盖新账户、新列表或更新后的 URL。本地存储暂不可用时仍可展示本页查询结果，不影响记录操作。

缓存复用避免重复请求后台查询同一封面地址，不会停止记录状态的只读刷新；浏览器仍可能按自己的图片缓存策略向 Apple 图片服务请求图片。请求需已有后台访问权限，不为可选封面弹出新的授权提示。封面失败保持中性结果，不改变服务的 `busy`、连接状态或错误状态。仅应用本地缓存更新无需再次更新 Cloudflare 后台；已有后台缺少封面接口或修复时，仍需按上述入口更新后台。

## 离线预览封面来源

本地 `?demo=ledger` 的播放记录是虚构演示数据，不读取真实账户；歌曲和专辑封面来自对应的真实 Apple Music 条目。预览中的 10 条聆听记录包含同一歌曲的多次播放，按下表的精确歌曲 ID 复用六个本地资源，图片已随扩展包附带，运行预览时不需要向 Apple CDN 发起图片请求。真实账户不使用这份演示映射。

本次通过 Apple 官方 `https://itunes.apple.com/lookup?id=<歌曲 ID>&country=tw&entity=song` 返回的 `trackId`、`collectionId`、名称和 `artworkUrl100` 核对对应关系；下方提供可重查的官方条目与查询。图片作品及封面相关权利归各自权利方。

| 歌曲 / 歌手             | 专辑       | 歌曲 ID      | 专辑 ID      | 随包文件（`apps/browser-extension/assets/`） | 官方来源                                                                                                                                                 |
| ----------------------- | ---------- | ------------ | ------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High High High / 張惠妹 | 牽手       | `1854820331` | `1854820324` | `album-preview-holding-hands.jpg`            | [Apple Music](https://music.apple.com/tw/album/1854820324?i=1854820331) · [Lookup](https://itunes.apple.com/lookup?id=1854820331&country=tw&entity=song) |
| 聽海 / 張惠妹           | BAD BOY    | `1854824118` | `1854824111` | `album-preview-bad-boy.jpg`                  | [Apple Music](https://music.apple.com/tw/album/1854824111?i=1854824118) · [Lookup](https://itunes.apple.com/lookup?id=1854824118&country=tw&entity=song) |
| 晴天 / 周杰倫           | 葉惠美     | `535824738`  | `535824731`  | `album-preview-yeh-hui-mei.jpg`              | [Apple Music](https://music.apple.com/tw/album/535824731?i=535824738) · [Lookup](https://itunes.apple.com/lookup?id=535824738&country=tw&entity=song)    |
| 七里香 / 周杰倫         | 七里香     | `536115195`  | `536114662`  | `album-preview-common-jasmin-orange.jpg`     | [Apple Music](https://music.apple.com/tw/album/536114662?i=536115195) · [Lookup](https://itunes.apple.com/lookup?id=536115195&country=tw&entity=song)    |
| 稻香 / 周杰倫           | 魔杰座     | `1624001324` | `1624000713` | `album-preview-capricorn.jpg`                | [Apple Music](https://music.apple.com/tw/album/1624000713?i=1624001324) · [Lookup](https://itunes.apple.com/lookup?id=1624001324&country=tw&entity=song) |
| 夜曲 / 周杰倫           | 11月的蕭邦 | `536009642`  | `536009641`  | `album-preview-novembers-chopin.jpg`         | [Apple Music](https://music.apple.com/tw/album/536009641?i=536009642) · [Lookup](https://itunes.apple.com/lookup?id=536009642&country=tw&entity=song)    |
