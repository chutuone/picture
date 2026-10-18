# 图提取 ImageGrab

Chrome 电商图片提取下载插件。在淘宝 / 天猫、京东、拼多多商家版的商品详情页，一键提取页面内所有商品图片，在画廊页勾选后批量下载为 PNG。

## 目录结构

```
image-grab/
├── manifest.json              # 扩展配置（Manifest V3）
├── background.js              # Service Worker：存结果、转 PNG、批量下载、进度推送
├── content.js                 # 内容脚本：注入悬浮按钮 + 扫描/过滤图片
├── content.css                # 悬浮按钮与提示样式
├── gallery.html               # 画廊页
├── gallery.css                # 画廊页样式
├── gallery.js                 # 画廊页逻辑（勾选、下载、进度）
├── icons/                     # 扩展图标 16 / 48 / 128
├── docs/                      # 纯静态宣传官网
│   ├── index.html
│   ├── css/style.css
│   ├── js/main.js
│   └── assets/favicon.svg
└── image-grab-extension.zip   # 可直接分发的扩展压缩包
```

## 安装

1. 下载 `image-grab-extension.zip` 并解压到本地文件夹（或直接使用本项目根目录）。
2. 打开 Chrome，地址栏输入 `chrome://extensions` 回车。
3. 打开右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择解压后的文件夹（含 `manifest.json` 的那一层）。
5. 安装完成后可把「图提取」固定到工具栏；点击图标随时打开画廊。

## 使用

1. 打开商品详情页，例如：
   - 淘宝：`item.taobao.com/item.htm?id=...`
   - 天猫：`detail.tmall.com/item.htm?id=...`
   - 京东：`item.jd.com/100012043978.html`
   - 拼多多：`mobile.yangkeduo.com/goods.html?goods_id=...`、`mms.pinduoduo.com/goods/...`
2. 页面右下角出现「获取图片」按钮，点击后开始扫描（长页面会依次预加载图片以判断尺寸）。
3. 扫描完成后自动打开画廊页，网格中展示所有图片与尺寸，左上角复选框勾选，支持全选 / 反选。
4. 点击「下载选中」，扩展会在后台抓取原图、统一转成 PNG，并保存到浏览器默认下载目录：
   - 文件名规则：`商品图_001.png`、`商品图_002.png`……按选中顺序递增补零。
   - 底部状态栏实时显示进度与成功 / 失败数量。

## 过滤规则

以下图片会被自动排除：

- URL 命中 `logo / icon / avatar / sprite / placeholder / 1x1 / pixel / qrcode` 等关键字
- SVG、GIF 等非照片格式
- 实际尺寸小于 100×100 的图片（先用 `naturalWidth` 判断，未知尺寸的会预加载探测，超时 5 秒或加载失败的丢弃）

## 实现要点

- **MV3 权限**：`activeTab`、`scripting`、`downloads`、`storage`；`host_permissions` 覆盖三个平台域名及常见图片 CDN（`alicdn.com`、`tbcdn.cn`、`360buyimg.com`、`jdimg.com`、`pddpic.com`）。
- **跨域转 PNG**：在 Service Worker 中 `fetch` 原图 → `createImageBitmap` → `OffscreenCanvas` → `convertToBlob({type:'image/png'})`，再转成 data URL 交给 `chrome.downloads.download`，避免页面 canvas 被跨域污染。
- **结果传递**：提取结果写入 `chrome.storage.local`（键名 `ig_session`），画廊页打开后读取，避免消息通道在页面刷新后失效。
- **SPA 兼容**：内容脚本以 2 秒低频轮询 + `popstate` / `hashchange` 重新判断当前是否为详情页，非详情页自动隐藏按钮。

## 已知限制

- 若图片服务器要求特定 Referer 或有防盗链签名，后台抓取可能失败，状态栏会给出失败原因。此类图片可在页面中右键「图片另存为」。
- 超大图片（十几 MB 的原图）转 data URL 后体积会膨胀约 1/3，极端情况下下载可能失败，建议分几次少量勾选。
- 首次点击「获取图片」时，未加载的懒加载图片需要预加载探测尺寸，图片很多时需等待几秒。

## 官网预览

`docs/index.html` 为纯静态站点，双击即可在浏览器打开；「下载插件」按钮指向项目根目录的 `image-grab-extension.zip`。修改主题色只需调整 `docs/css/style.css` 中 `:root` 的 `--primary` 与 `--primary-2`。
