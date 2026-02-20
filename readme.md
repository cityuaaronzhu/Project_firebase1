# 雾霾提醒后端 - 部署与配置

- **运行时**：Node.js 22（避免使用已弃用的 Node 20）
- **前置**：需先启用 Firestore 并创建数据库，否则函数会报 `PERMISSION_DENIED`

---

## 1. 前置条件：Firestore

函数会读写 Firestore 的 `state/beijing_haidian`，用于防刷与状态记录。

- 打开 [Firebase Console](https://console.firebase.google.com/) → 你的项目 → **Build** → **Firestore Database**
- 若未创建过：点 **「创建数据库」**，选生产或测试模式、选区域，完成创建
- **无需手动添加数据**：首次执行时函数会自动创建 `state` 集合和 `beijing_haidian` 文档

若未启用 Firestore 就部署，运行时会报错：`Cloud Firestore API has not been used in project ... or it is disabled`。可点错误中的链接启用 API，或在 Firebase 里创建数据库（会一并启用）。

---

## 2. 需要设置的 Firebase Secrets 列表

| Secret 名称 | 说明 | 获取方式 |
|------------|------|----------|
| `WAQI_TOKEN` | WAQI 接口 token | 见下方「WAQI Token」 |
| `PUSHOVER_APP_TOKEN` | Pushover 应用 token | 见下方「Pushover」 |
| `PUSHOVER_USER_KEY` | Pushover 用户 key | 见下方「Pushover」 |

### WAQI Token

- 打开 [WAQI API](https://aqicn.org/api/)
- 点 **「Get your API token」** / **Sign Up**，用邮箱注册并登录
- 登录后在 **API** 或 **Dashboard** 页面看到 **API Key / Token**，复制即为 `WAQI_TOKEN`

### Pushover（两个值都要）

- **User Key**：登录 [Pushover](https://pushover.net/)，首页的 **「Your User Key」** → 用作 `PUSHOVER_USER_KEY`
- **API Token**：同一站内点 **「Your Applications」** → **「Create an Application」**，填应用名（如「雾霾提醒」）、类型选 Application，提交后页面显示的 **「API Token」** → 用作 `PUSHOVER_APP_TOKEN`

---

## 3. 本地环境与登录

- 需要已安装 **Node.js**（建议 18+，项目使用 Node 22）和 **npm**
- 安装 Firebase CLI：`npm install -g firebase-tools`
- 若在 Cursor/VS Code 终端里找不到 `node`/`npm`：可重启编辑器，或在终端执行  
  `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")`（PowerShell）刷新 PATH；或把默认终端改为 CMD

登录：

```bash
firebase login
```

若提示 **Login Failed** 或 **credentials are no longer valid**：

- 先试：`firebase login --reauth` 或 `firebase login --reauth --no-localhost`（后者会给出链接，在浏览器打开后把授权码贴回终端）
- 若本地仍无法登录：改用 **Google Cloud Shell** 部署（见第 5 节）

---

## 4. 设置 Secrets 与部署（本地）

在 **项目根目录**（与 `firebase.json` 同级）执行：

```bash
# 设置三个 Secret（每条会提示输入值）
firebase functions:secrets:set WAQI_TOKEN
firebase functions:secrets:set PUSHOVER_APP_TOKEN
firebase functions:secrets:set PUSHOVER_USER_KEY

# 安装依赖并部署
cd functions
npm install
cd ..
firebase deploy --only functions
```

或一条命令安装并部署：

```bash
npm --prefix functions install && firebase deploy --only functions
```

部署成功后，定时函数会按「每 10 分钟」在云端执行。

从文件读入 Secret（避免在终端里粘贴明文）：

- Linux/macOS：`echo -n "你的WAQI_TOKEN" | firebase functions:secrets:set WAQI_TOKEN --data-file=-`
- Windows PowerShell：`"你的WAQI_TOKEN" | firebase functions:secrets:set WAQI_TOKEN --data-file=-`

---

## 5. 通过 Google Cloud Shell 部署（本地登录失败时推荐）

1. 浏览器打开 [Google Cloud Console](https://console.cloud.google.com/)，选你的项目
2. 右上角打开 **Cloud Shell**（终端图标）
3. 安装 CLI 并登录：
   ```bash
   npm install -g firebase-tools
   firebase login
   ```
   在弹出浏览器中完成授权
4. 把代码弄到 Cloud Shell：
   - 若在 GitHub：`git clone https://github.com/你的用户名/仓库名.git && cd 仓库名`
   - 若只在本地：在 Cloud Shell 点 **⋮** → **上传**，上传项目 zip 后解压并 `cd` 进项目目录
5. 选项目、设 Secret、部署：
   ```bash
   firebase use 你的Firebase项目ID
   firebase functions:secrets:set WAQI_TOKEN
   firebase functions:secrets:set PUSHOVER_APP_TOKEN
   firebase functions:secrets:set PUSHOVER_USER_KEY
   cd functions && npm install && cd ..
   firebase deploy --only functions
   ```

---

## 6. 查看日志验证

- **控制台**：Firebase Console → 你的项目 → **Functions** → 点击 `smogReminder` → **日志** 标签
- **命令行**：`firebase functions:log` 或 `firebase functions:log --only smogReminder`

日志中会包含：`aqi`、`pm25`、`level`、`needMask`、`levelChanged`、`cooldownPassed`、是否发送（`sent`）、Pushover 返回（成功/失败）。WAQI 或 Pushover 出错时会有 `console.error`，便于排查。
