# 局域网快传 (LocalDrop)

这是一个纯前端的局域网 P2P 文件/文本传输工具，灵感来源于 Snapdrop。

## 特性

*   **P2P 传输**: 使用 WebRTC 直接点对点传输文件和文本，不消耗服务器带宽，速度极快。
*   **隐私安全**: 文件不经过第三方服务器，仅信令数据（握手信息）通过公共 MQTT 交换。
*   **纯静态架构**: 没有后端代码，完全运行在浏览器中。
*   **中文本地化**: 全中文界面和随机昵称。
*   **即时发现**: 基于公网 IP 自动发现同一网络下的设备。
*   **跨平台**: 支持 PC 和 手机端（长按头像发送文字）。

## 部署

本项目可以直接部署到任何静态网站托管服务，特别是 **Cloudflare Pages**。

### 部署到 Cloudflare Pages (推荐)

1.  Fork 本仓库到你的 GitHub。
2.  登录 Cloudflare Dashboard，进入 **Pages**。
3.  点击 **Create a project** > **Connect to Git**。
4.  选择本项目仓库。
5.  **Build settings** 留空即可（Framework preset: None, Build command: (空), Build output directory: `public`）。
6.  点击 **Save and Deploy**。

### 本地运行

如果你想在本地开发：

1.  安装依赖（仅用于本地服务器）：
    ```bash
    npm install -g http-server
    ```
2.  进入 public 目录并启动：
    ```bash
    cd public
    http-server -p 8080
    ```
3.  浏览器访问 `http://localhost:8080`。

## 原理

*   **信令 (Signaling)**: 使用免费的公共 MQTT Broker (`broker.hivemq.com`) 进行设备发现和 WebRTC 握手。设备根据公网 IP 订阅特定 Topic 从而发现同一局域网下的其他设备。
*   **传输 (Transport)**: 建立 WebRTC DataChannel 进行 P2P 数据传输。

## 注意事项

*   由于使用公共 MQTT Broker，请勿用于传输极度机密的信令（虽然文件内容本身是点对点加密的，但元数据如文件名可能会在信令中明文传输）。
*   请确保网络环境允许 WebSocket 和 WebRTC 连接。
