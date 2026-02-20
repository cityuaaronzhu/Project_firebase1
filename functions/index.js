/**
 * 个人版雾霾提醒 - Firebase Cloud Functions v2
 * 定时拉取 WAQI 海淀数据，按规则决定是否通过 Pushover 推送提醒
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();

const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 小时
const STATE_COLLECTION = "state";
const STATE_DOC_ID = "beijing_haidian";
const WAQI_FEED_URL = "https://api.waqi.info/feed/@452/?token=";

// 声明需要注入的 Secrets（部署时需在 Firebase 中配置）
const waqiTokenSecret = defineSecret("WAQI_TOKEN");
const pushoverAppTokenSecret = defineSecret("PUSHOVER_APP_TOKEN");
const pushoverUserKeySecret = defineSecret("PUSHOVER_USER_KEY");

/**
 * 从 WAQI API 拉取空气质量数据
 * @returns {{ aqi: number, pm25: number | null } | null} 解析成功返回数据，失败返回 null
 */
async function fetchWaqiData() {
  const token = process.env.WAQI_TOKEN;
  if (!token) {
    console.error("[WAQI] 缺少环境变量 WAQI_TOKEN，请设置 Firebase Secret WAQI_TOKEN");
    return null;
  }

  const url = WAQI_FEED_URL + token;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error("[WAQI] 请求失败:", err.message);
    return null;
  }

  if (!res.ok) {
    console.error("[WAQI] HTTP 状态异常:", res.status, res.statusText);
    return null;
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error("[WAQI] 响应 JSON 解析失败:", err.message);
    return null;
  }

  if (json.status !== "ok") {
    console.error("[WAQI] API 返回 status != ok:", json.status, json.data || "");
    return null;
  }

  const aqi = json.data?.aqi;
  if (typeof aqi !== "number") {
    console.error("[WAQI] 缺少或无效 data.aqi:", aqi);
    return null;
  }

  const pm25Val = json.data?.iaqi?.pm25?.v;
  const pm25 = typeof pm25Val === "number" ? pm25Val : null;

  return { aqi, pm25 };
}

/**
 * 根据 AQI 计算是否需要戴口罩及等级
 */
function decideLevel(aqi) {
  if (aqi >= 151) return { needMask: true, level: "heavy" };
  if (aqi >= 101) return { needMask: true, level: "light" };
  return { needMask: false, level: "good" };
}

/**
 * 发送 Pushover 推送
 * @returns {{ success: boolean, detail?: string }}
 */
async function sendPushover(title, message) {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;

  if (!token || !user) {
    const missing = [!token && "PUSHOVER_APP_TOKEN", !user && "PUSHOVER_USER_KEY"].filter(Boolean);
    console.error("[Pushover] 缺少环境变量:", missing.join(", "));
    return { success: false, detail: "missing_secrets" };
  }

  const body = new URLSearchParams({
    token,
    user,
    title,
    message,
    sound: "default",
  }).toString();

  let res;
  try {
    res = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    console.error("[Pushover] 请求失败:", err.message);
    return { success: false, detail: err.message };
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error("[Pushover] 响应 JSON 解析失败:", err.message);
    return { success: false, detail: "invalid_json" };
  }

  if (json.status !== 1) {
    console.error("[Pushover] API 返回 status != 1:", json);
    return { success: false, detail: JSON.stringify(json) };
  }

  return { success: true };
}

/**
 * 定时任务：每 10 分钟执行
 * - 拉取 WAQI 数据 -> 决策 needMask/level
 * - 读 Firestore 状态 -> 判断 levelChanged / cooldownPassed
 * - 若 needMask 且 (levelChanged 或 cooldownPassed) 则发 Pushover，并更新 notifiedAtMs
 * - 始终更新 level/lastAqi/lastPm25/updatedAt
 */
exports.smogReminder = onSchedule(
  {
    schedule: "every 10 minutes",
    secrets: [waqiTokenSecret, pushoverAppTokenSecret, pushoverUserKeySecret],
  },
  async (event) => {
    // 启动时检查必要 Secrets（v2 会注入到 process.env）
    if (!process.env.WAQI_TOKEN) {
      console.error("缺少 Secret: WAQI_TOKEN。请在 Firebase 中配置并重新部署。");
      return;
    }
    if (!process.env.PUSHOVER_APP_TOKEN || !process.env.PUSHOVER_USER_KEY) {
      console.error("缺少 Secret: PUSHOVER_APP_TOKEN 或 PUSHOVER_USER_KEY。请在 Firebase 中配置并重新部署。");
      return;
    }

    const waqiData = await fetchWaqiData();
    if (!waqiData) {
      return;
    }

    const { aqi, pm25 } = waqiData;
    const { needMask, level } = decideLevel(aqi);

    const stateRef = db.collection(STATE_COLLECTION).doc(STATE_DOC_ID);
    const stateSnap = await stateRef.get();

    const nowMs = Date.now();
    const prevLevel = stateSnap.exists ? stateSnap.data().level : null;
    const notifiedAtMs = stateSnap.exists && stateSnap.data().notifiedAtMs != null
      ? stateSnap.data().notifiedAtMs
      : 0;

    const levelChanged = prevLevel !== null && prevLevel !== level;
    const cooldownPassed = nowMs - notifiedAtMs >= COOLDOWN_MS;

    const shouldNotify = needMask && (levelChanged || cooldownPassed);

    let pushoverResult = null;
    if (shouldNotify) {
      const title = "海淀空气质量提醒";
      const message =
        level === "light"
          ? `当前 AQI ${aqi}（轻度污染），出门建议戴口罩。`
          : `当前 AQI ${aqi}（较重污染），建议佩戴口罩并减少户外。`;
      pushoverResult = await sendPushover(title, message);
    }

    // 无论是否通知，都更新 level / lastAqi / lastPm25 / updatedAt
    const updateData = {
      level,
      lastAqi: aqi,
      lastPm25: pm25,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (shouldNotify && pushoverResult && pushoverResult.success) {
      updateData.notifiedAtMs = nowMs;
    }

    await stateRef.set(updateData, { merge: true });

    const sent = shouldNotify && pushoverResult && pushoverResult.success;
    const pushoverDetail = pushoverResult
      ? (pushoverResult.success ? "成功" : `失败: ${pushoverResult.detail || ""}`)
      : "未发送";

    console.log(JSON.stringify({
      aqi,
      pm25,
      level,
      needMask,
      levelChanged,
      cooldownPassed,
      shouldNotify,
      sent,
      pushover: pushoverDetail,
    }));
  }
);
