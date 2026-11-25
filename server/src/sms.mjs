// Sign-in codes by text message, through one of two Alibaba Cloud services (SMS_SERVICE):
// - `sms`, Short Message Service (dysmsapi SendSms): the server makes the code, keeps its hash
//   and checks it (signin.mjs); the service only delivers it.
// - `pnvs`, Phone Number Verification Service (dypnsapi): the service makes the code, texts it
//   and checks it. The server still limits requests and attempts and lets a code work once,
//   since the service does not say a checked code stops working.

import crypto from 'node:crypto';

const encode = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
  `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
);

function signature(parameters, secret) {
  const canonical = Object.keys(parameters)
    .sort()
    .map((key) => `${encode(key)}=${encode(parameters[key])}`)
    .join('&');
  const stringToSign = `POST&%2F&${encode(canonical)}`;
  return crypto.createHmac('sha1', `${secret}&`).update(stringToSign).digest('base64');
}

export function normalizePhone(value) {
  const phone = String(value ?? '').trim().replace(/^\+86/, '');
  if (!/^1[3-9]\d{9}$/.test(phone))
    throw Object.assign(new Error('手机号格式无效。'), { status: 400 });
  return phone;
}

/** Codes are made and checked by the service, not by this server. A dry run makes its own. */
export const serviceChecksCodes = (config) => config.sms.service === 'pnvs' && !config.sms.dryRun;

// The code's length and lifetime, which signin.mjs's own expiry matches.
export const CODE_DIGITS = 6;
export const CODE_MINUTES = 5;

/** One signed call to an Alibaba Cloud RPC API; answers its JSON when the call succeeded. */
async function call(sms, host, parameters, failure) {
  if (!sms.accessKeyId || !sms.accessKeySecret || !sms.signName || !sms.templateCode) {
    throw new Error('短信服务尚未配置。');
  }
  const signed = {
    ...parameters,
    AccessKeyId: sms.accessKeyId,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString(),
    Version: '2017-05-25',
  };
  const response = await fetch(`https://${host}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...signed, Signature: signature(signed, sms.accessKeySecret) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.Code !== 'OK') {
    throw Object.assign(new Error(`${failure}：${result.Message ?? response.status}`), {
      code: result.Code,
    });
  }
  return result;
}

/** Texts a sign-in code: `code` with Short Message Service; one the service makes with PNVS. */
export async function sendVerificationCode(config, phone, code) {
  if (config.sms.dryRun) return;
  const sms = config.sms;
  if (serviceChecksCodes(config)) {
    await call(
      sms,
      'dypnsapi.aliyuncs.com',
      {
        Action: 'SendSmsVerifyCode',
        CountryCode: '86',
        PhoneNumber: phone,
        SignName: sms.signName,
        TemplateCode: sms.templateCode,
        // ##code## has the service make the code, which only then can it check; the system
        // templates also take the minutes it stays valid.
        TemplateParam: JSON.stringify({ code: '##code##', min: String(CODE_MINUTES) }),
        CodeLength: String(CODE_DIGITS),
        CodeType: '1',
        ValidTime: String(CODE_MINUTES * 60),
        Interval: '60',
      },
      '短信发送失败',
    );
    return;
  }
  await call(
    sms,
    'dysmsapi.aliyuncs.com',
    {
      Action: 'SendSms',
      PhoneNumbers: phone,
      RegionId: sms.regionId,
      SignName: sms.signName,
      TemplateCode: sms.templateCode,
      TemplateParam: JSON.stringify({ code }),
    },
    '短信发送失败',
  );
}

/** Whether PNVS accepts the code it texted to the number. */
export async function checkVerificationCode(config, phone, code) {
  // Anything but six digits cannot be the code, and is not worth a call.
  if (code.length !== CODE_DIGITS || !/^\d+$/.test(code)) return false;
  let result;
  try {
    result = await call(
      config.sms,
      'dypnsapi.aliyuncs.com',
      { Action: 'CheckSmsVerifyCode', CountryCode: '86', PhoneNumber: phone, VerifyCode: code },
      '验证码校验失败',
    );
  } catch (error) {
    // A wrong, expired or replaced code is refused with this error rather than a failed result.
    if (error.code === 'isv.ValidateFail') return false;
    throw error;
  }
  // A successful call is not a passed check; only the result says so.
  return result.Model?.VerifyResult === 'PASS';
}
