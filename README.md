# 数学错题本 (wrongbook)

手机拍照录题 → AI 识别题目（含公式与图形）→ Web 端管理 → 选题组卷、排版打印、重练巩固。

## 当前进度

**已完成**：手机拍照 → 框选单页多题 → 上传 → AI 识别文字/图形/答案 → Web 管理端编辑、筛选、排序、选题组卷与打印。

后续规划：手机端重练自评、连对 3 次自动移出题库。

## 目录结构

```
wrongbook/
├── server.py             # 后端：托管页面 + 上传 + Gemini 识别 + 题库读写
├── index.html / app.js   # 手机拍照端（拍照、框选、上传）
├── admin.html / admin.js # Web 管理端（题库管理、筛选、选题组卷）
├── paper.html / paper.js # 练习卷排版、同类题生成与打印
├── style.css
├── config.json           # API 配置（需自行创建，已在 .gitignore 中）
├── config.example.json   # 配置模板
├── data/questions.json   # 题库
└── uploads/              # 题目图片（不入库）
```

## 配置

1. 复制配置模板：
   ```bash
   cp config.example.json config.json
   ```
2. 编辑 `config.json`，填入 Gemini API Key（从 https://aistudio.google.com/apikey 获取）：
   ```json
   {
     "gemini_api_key": "你的真实Key",
     "model": "gemini-2.0-flash",
     "port": 8788
   }
   ```
   > `config.json` 已在 `.gitignore` 中，不会被提交，避免密钥泄露。

## 运行

仅需 Python 3 标准库，无第三方依赖：

```bash
cd wrongbook
python3 server.py
```

启动后终端会显示访问地址（默认端口 `8788`）：

- 手机拍照端：http://\<本机IP\>:8788/
- Web 管理端：http://\<本机IP\>:8788/admin.html

手机需与电脑连同一 WiFi。查本机 IP：`ipconfig getifaddr en0`。

## 使用流程

1. 手机浏览器打开拍照端，点「拍照」（或从相册选图）。
2. 在照片上**按住拖动**画框，框出每一道题；一页可框多道，序号会标在图上。
   - 框错了可单独「删除」，或「清空框选」重来。
3. 点「上传 N 道题」，后端逐张裁剪并调用 Gemini 识别。
4. 识别结果直接显示在页面上（题目文字用 LaTeX 表示公式、图形描述、知识点分类）。
5. 到 Web 管理端查看全部题目，支持按文字/知识点搜索、按掌握状态筛选、排序、修改与删除。
6. 在「组卷练习」中选择出题，勾选题目后进入排版；也可自动抽取指定数量。排版页可删除单题、用 AI 替换同类题，最后直接打印。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 检查 Key 配置状态、当前模型、题库数量 |
| POST | `/api/upload` | 接收 `{image: "data:image/jpeg;base64,..."}`，识别并入库 |
| GET | `/api/questions` | 返回题库数组 |
| POST | `/api/questions` | 保存整个题库数组 |
| POST | `/api/generate-similar` | 根据原题生成一道同类题 |
| GET | `/api/test` | 测试 API Key 是否可用 |

## 题目数据结构

```json
{
  "id": "q_xxx",
  "image": "uploads/xxx.jpg",
  "text": "题目文字，数学部分为 LaTeX",
  "has_figure": true,
  "figure_desc": "图形关键特征描述",
  "topic": "知识点分类",
  "answer": "",
  "status": "new",
  "streak": 0,
  "history": [],
  "createdAt": "2026-09-03T10:00:00"
}
```

`status`/`streak`/`history` 为后续「连对 3 次不再出题」预留。
