const DEEPSEEK_BASE_URL = "https://chat.deepseek.com";

const APP_HEADERS = Object.freeze({
  appVersion: "20241129.1",
  clientVersion: "1.8.0",
  clientPlatform: "web",
  locale: "zh_CN",
  timezoneOffset: "28800"
});

export function createBaseHeaders(token, extraHeaders = {}) {
  const headers = {
    "x-app-version": APP_HEADERS.appVersion,
    "x-client-version": APP_HEADERS.clientVersion,
    "x-client-platform": APP_HEADERS.clientPlatform,
    "x-client-locale": APP_HEADERS.locale,
    "x-client-timezone-offset": APP_HEADERS.timezoneOffset,
    ...extraHeaders
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function isEmail(loginValue) {
  return loginValue.includes("@");
}

function buildLoginPayload(loginValue, password, deviceId) {
  return {
    email: isEmail(loginValue) ? loginValue : "",
    mobile: isEmail(loginValue) ? "" : loginValue,
    password,
    area_code: "+86",
    device_id: deviceId,
    os: "web"
  };
}

export async function loginToDeepseek({ loginValue, password, deviceId }) {
  const response = await fetch(`${DEEPSEEK_BASE_URL}/api/v0/users/login`, {
    method: "POST",
    headers: createBaseHeaders("", { "content-type": "application/json" }),
    body: JSON.stringify(buildLoginPayload(loginValue, password, deviceId))
  });

  const result = await response.json();
  if (result.data?.biz_code !== 0) {
    throw new Error(result.msg || result.data?.biz_msg || "DeepSeek 登录失败");
  }

  return result;
}

export async function refreshAccountToken(account) {
  const loginResult = await loginToDeepseek({
    loginValue: account.loginValue,
    password: account.password,
    deviceId: account.deviceId
  });

  return {
    ...account,
    token: loginResult.data.biz_data.user.token
  };
}

export { DEEPSEEK_BASE_URL };
