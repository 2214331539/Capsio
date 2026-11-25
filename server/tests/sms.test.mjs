import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkVerificationCode, sendVerificationCode, serviceChecksCodes } from '../src/sms.mjs';

const sms = (service, extra = {}) => ({
  sms: {
    service,
    accessKeyId: 'id',
    accessKeySecret: 'secret',
    signName: '恒创联众',
    templateCode: '100001',
    regionId: 'cn-hangzhou',
    dryRun: false,
    ...extra,
  },
});

const realFetch = globalThis.fetch;
let calls;
function answer(body, status = 200) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(init.body)) });
    return new Response(JSON.stringify(body), { status });
  };
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('with PNVS the service makes a six-digit code that lasts five minutes', async () => {
  answer({ Code: 'OK', Success: true, Model: {} });
  await sendVerificationCode(sms('pnvs'), '13800000000', null);
  const [{ url, form }] = calls;
  assert.equal(url, 'https://dypnsapi.aliyuncs.com/');
  assert.equal(form.Action, 'SendSmsVerifyCode');
  assert.equal(form.PhoneNumber, '13800000000');
  assert.equal(form.CountryCode, '86');
  assert.equal(form.SignName, '恒创联众');
  assert.equal(form.TemplateCode, '100001');
  assert.deepEqual(JSON.parse(form.TemplateParam), { code: '##code##', min: '5' });
  assert.equal(form.CodeLength, '6');
  assert.equal(form.ValidTime, '300');
  assert.ok(form.Signature);
});

test('only a PASS result accepts a PNVS code', async () => {
  answer({ Code: 'OK', Success: true, Model: { VerifyResult: 'PASS' } });
  assert.equal(await checkVerificationCode(sms('pnvs'), '13800000000', '123456'), true);
  assert.equal(calls[0].form.Action, 'CheckSmsVerifyCode');
  assert.equal(calls[0].form.VerifyCode, '123456');

  answer({ Code: 'OK', Success: true, Model: { VerifyResult: 'UNKNOWN' } });
  assert.equal(await checkVerificationCode(sms('pnvs'), '13800000000', '123456'), false);

  // What the service actually answers for a wrong code (seen 2026-11-25).
  answer({ Code: 'isv.ValidateFail', Message: '验证失败' }, 400);
  assert.equal(await checkVerificationCode(sms('pnvs'), '13800000000', '123456'), false);

  answer({ Code: 'SignatureDoesNotMatch', Message: 'Specified signature is not matched' }, 400);
  await assert.rejects(checkVerificationCode(sms('pnvs'), '13800000000', '123456'), /signature/);

  answer({ Code: 'OK', Model: { VerifyResult: 'PASS' } });
  assert.equal(await checkVerificationCode(sms('pnvs'), '13800000000', '12a456'), false);
  assert.equal(calls.length, 0, 'a code of the wrong shape is not sent to the service');
});

test('a refused call is an error, not a wrong code', async () => {
  answer({ Code: 'isv.BUSINESS_LIMIT_CONTROL', Message: '触发号码天级流控' }, 400);
  await assert.rejects(sendVerificationCode(sms('pnvs'), '13800000000', null), /触发号码天级流控/);
});

test('Short Message Service texts the code the server made', async () => {
  answer({ Code: 'OK' });
  await sendVerificationCode(sms('sms', { templateCode: 'SMS_1' }), '13800000000', '654321');
  assert.equal(calls[0].url, 'https://dysmsapi.aliyuncs.com/');
  assert.equal(calls[0].form.Action, 'SendSms');
  assert.deepEqual(JSON.parse(calls[0].form.TemplateParam), { code: '654321' });
});

test('a dry run texts nothing and keeps codes on the server', async () => {
  answer({ Code: 'OK' });
  const config = sms('pnvs', { dryRun: true });
  await sendVerificationCode(config, '13800000000', '654321');
  assert.equal(calls.length, 0);
  assert.equal(serviceChecksCodes(config), false);
  assert.equal(serviceChecksCodes(sms('pnvs')), true);
  assert.equal(serviceChecksCodes(sms('sms')), false);
});
