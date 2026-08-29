# LAYRA ComfyUI 抠图工作流

当前接入的是 ComfyUI 官方原生 BiRefNet 背景移除工作流。应用会继续使用现有视觉模型识别一张照片中的每件衣物，再将无需遮挡补全的单件裁剪图交给这个工作流。

## 本地准备

1. 更新 ComfyUI 到包含 `LoadBackgroundRemovalModel` 和 `RemoveBackground` 节点的版本。
2. 下载 `birefnet.safetensors`，放入 `ComfyUI/models/background_removal/`。
3. 启动 ComfyUI，并确保应用服务器可以访问它。默认端口是 `8188`。
4. 在项目 `.env.local` 中设置：

```dotenv
CUTOUT_PROVIDER=hybrid
COMFYUI_BASE_URL=http://127.0.0.1:8188
COMFYUI_BIREFNET_MODEL=birefnet.safetensors
COMFYUI_TIMEOUT_MS=12000
```

重启 `npm run dev` 后，直接从 LAYRA 的“我的衣柜”上传照片。衣物确认卡会显示实际使用的是“本地 ComfyUI”还是“云端抠图”。

`hybrid` 会优先使用 ComfyUI，服务未启动、执行超时或结果不合格时自动回退到阿里云。`comfyui` 只使用本地服务，适合排查工作流；`aliyun` 保持原有行为。

## 手动验证

`layra-birefnet-cutout.api.json` 是 API 格式参考。应用运行时会替换输入文件名和输出前缀，不需要手动改这个文件。多衣物分类面板和被人体遮挡衣物的补全仍由现有链路处理，因为 BiRefNet 只分离可见前景，不负责辨认多件衣物或生成不可见结构。
