import { randomBytes, randomInt } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import qrcode from 'qrcode-terminal';
import { readJson, saveJson, sleep } from './common.js';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

const entry = 'https://ilinkai.weixin.qq.com';
const version = '2.4.8';
const appVersion = String((2 << 16) + (4 << 8) + 8);

async function request(base, path, token, value, timeout = 45000) {
  const headers = {
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomInt(0, 0x100000000))).toString('base64'),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': appVersion
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(new URL(path, base), {
    method: value === undefined ? 'GET' : 'POST',
    headers,
    body: value === undefined ? undefined : JSON.stringify(value),
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`WeChat HTTP ${response.status}`);
  return response.json();
}

export class WeChatTextClient {
  constructor({ credentialFile, cursorFile, onMessage }) {
    this.credentialFile = credentialFile;
    this.cursorFile = cursorFile;
    this.onMessage = onMessage;
    this.credentials = null;
  }

  async login() {
    this.credentials = await readJson(this.credentialFile, null);
    if (this.credentials) return;
    for (let refresh = 0; refresh < 4; refresh++) {
      const qr = await request(entry, '/ilink/bot/get_bot_qrcode?bot_type=3', null, { local_token_list: [] });
      if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('WeChat did not return a QR code');
      const matrix = new QRCode(-1, QRLevel.L);
      matrix.addData(qr.qrcode_img_content);
      matrix.make();
      const size = matrix.getModuleCount() + 8;
      const cells = [];
      for (let y = 0; y < matrix.getModuleCount(); y++) {
        for (let x = 0; x < matrix.getModuleCount(); x++) {
          if (matrix.isDark(y, x)) cells.push(`M${x + 4} ${y + 4}h1v1h-1z`);
        }
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="512" height="512"><rect width="${size}" height="${size}" fill="white"/><path d="${cells.join('')}" fill="black"/></svg>`;
      await mkdir(dirname(this.credentialFile), { recursive: true });
      await writeFile(resolve(dirname(this.credentialFile), 'login-qr.svg'), svg);
      qrcode.generate(qr.qrcode_img_content, { small: true });
      console.log('Scan the QR code with WeChat:', qr.qrcode_img_content);
      let base = entry;
      for (let count = 0; count < 100; count++) {
        const status = await request(base, `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, null, undefined, 60000);
        if (status.status === 'confirmed') {
          this.credentials = { token: status.bot_token, accountId: status.ilink_bot_id, baseUrl: status.baseurl || base };
          if (!this.credentials.token || !this.credentials.accountId) throw new Error('Incomplete WeChat credentials');
          await saveJson(this.credentialFile, this.credentials);
          return;
        }
        if (status.status === 'scaned_but_redirect' && status.redirect_host) {
          base = /^https?:\/\//.test(status.redirect_host) ? status.redirect_host : `https://${status.redirect_host}`;
        }
        if (status.status === 'expired') break;
        if (status.status === 'need_verifycode') throw new Error('WeChat requires verification code; complete verification in WeChat and restart');
        if (status.status === 'verify_code_blocked') throw new Error('WeChat QR verification blocked');
        await sleep(1000);
      }
    }
    throw new Error('WeChat login timed out');
  }

  async sendText(to, text, contextToken) {
    if (!contextToken) throw new Error('No WeChat context token yet');
    const base_info = { channel_version: version, bot_agent: 'OpenClaw' };
    const result = await request(this.credentials.baseUrl, '/ilink/bot/sendmessage', this.credentials.token, {
      msg: {
        from_user_id: '', to_user_id: to, client_id: randomBytes(16).toString('hex'),
        message_type: 2, message_state: 2, context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }]
      },
      base_info
    });
    if ((result.ret !== undefined && result.ret !== 0) || (result.errcode !== undefined && result.errcode !== 0)) {
      throw new Error(`WeChat send failed: ${result.errmsg || result.ret || result.errcode}`);
    }
  }

  async start() {
    try {
      await request(this.credentials.baseUrl, '/ilink/bot/msg/notifystart', this.credentials.token,
        { base_info: { channel_version: version, bot_agent: 'OpenClaw' } });
    } catch (error) { console.error('WeChat start notification:', error.message); }
    let cursor;
    try { cursor = await readFile(this.cursorFile, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; cursor = ''; }
    let failures = 0;
    while (true) {
      try {
        const result = await request(this.credentials.baseUrl, '/ilink/bot/getupdates', this.credentials.token,
          { get_updates_buf: cursor, base_info: { channel_version: version, bot_agent: 'OpenClaw' } }, 50000);
        if (result.ret === -14 || result.errcode === -14) throw new Error('WeChat session expired. Remove data/wechat.json and scan again');
        if ((result.ret && result.ret !== 0) || (result.errcode && result.errcode !== 0)) throw new Error(`WeChat poll failed: ${result.errmsg || result.ret || result.errcode}`);
        failures = 0;
        for (const message of result.msgs || []) {
          if (message.message_type !== 1) continue;
          const text = (message.item_list || []).filter((item) => item.type === 1).map((item) => item.text_item?.text || '').join('\n');
          if (text) await this.onMessage({
            from_user_id: message.from_user_id,
            context_token: message.context_token,
            message_id: message.message_id,
            text
          });
        }
        if (result.get_updates_buf) {
          cursor = result.get_updates_buf;
          await mkdir(dirname(this.cursorFile), { recursive: true });
          await writeFile(this.cursorFile, cursor, { mode: 0o600 });
        }
      } catch (error) {
        console.error('WeChat poll:', error.message);
        if (error.message.includes('session expired')) throw error;
        failures++;
        await sleep(Math.min(30000, 2000 * failures));
      }
    }
  }
}
